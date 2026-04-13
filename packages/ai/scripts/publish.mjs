#!/usr/bin/env node
/**
 * Publish this package as a single-format @synix fireoff variant.
 *
 *   node scripts/publish.mjs cjs 1
 *   node scripts/publish.mjs esm 2
 *
 * Behavior:
 *   - Resolves base version from package.json (strips any prior format suffix).
 *   - Mutates package.json in place: version → `${base}-${format}.${buildNum}`,
 *     `type` → `module`/`commonjs`, `exports` collapsed to single-condition
 *     (types + default).
 *   - Cleans dist, runs `tsgo -p tsconfig.build.<format>.json`.
 *   - `npm publish --tag <format>` (uses `cjs` / `esm` dist-tags so neither
 *     variant claims `latest`).
 *   - Tags the git commit: `<package-bare-name>/<published-version>`,
 *     pushes to origin.
 *   - Restores the original package.json regardless of success/failure so the
 *     working tree stays clean.
 */
import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(__dirname, '..', 'package.json')

const format = process.argv[2]
const buildNum = process.argv[3] ?? '1'
if (!['cjs', 'esm'].includes(format)) {
	console.error('Usage: publish.mjs <cjs|esm> [build-num]')
	process.exit(1)
}

// Map upstream @mariozechner names to our @synix fork namespace at publish time.
// Source code and workspace-linked package.json keep the @mariozechner names;
// only the emitted tarball's manifest carries @synix + npm: aliases for deps.
const PUBLISH_NAME_MAP = {
	'@mariozechner/pi-ai': '@synix/pi-ai',
	'@mariozechner/pi-agent-core': '@synix/pi-agent-core',
}
const FORK_REPO_URL = 'git+https://github.com/synix/pi-mono.git'

const original = readFileSync(pkgPath, 'utf-8')
const pkg = JSON.parse(original)

const publishName = PUBLISH_NAME_MAP[pkg.name]
if (!publishName) {
	console.error(`No @synix publish mapping for ${pkg.name}`)
	process.exit(1)
}

// Strip any prior format suffix to get the clean base version.
const baseVersion = pkg.version.replace(/-(cjs|esm)\.\d+$/, '')
const newVersion = `${baseVersion}-${format}.${buildNum}`
pkg.name = publishName
pkg.version = newVersion
pkg.type = format === 'esm' ? 'module' : 'commonjs'
pkg.publishConfig = { registry: 'https://npm.pkg.github.com', access: 'public' }
if (pkg.repository?.url) pkg.repository.url = FORK_REPO_URL

// Rewrite internal @mariozechner deps to npm: aliases pointing at the @synix
// tarball of the SAME format+buildNum (the workflow publishes pi-ai before
// pi-agent-core, so the aliased version already exists on the registry).
// Downstream installs land the content under node_modules/@mariozechner/pi-*,
// so the published dist's import paths keep resolving.
for (const section of ['dependencies', 'peerDependencies']) {
	const deps = pkg[section]
	if (!deps) continue
	for (const depName of Object.keys(deps)) {
		const aliased = PUBLISH_NAME_MAP[depName]
		if (aliased) deps[depName] = `npm:${aliased}@${newVersion}`
	}
}

// Collapse exports to single-condition: { types, default }.
// Original may have `import` / `require` keys; either becomes `default` here
// since we only ship one format per published version.
if (pkg.exports && typeof pkg.exports === 'object') {
	const collapsed = {}
	for (const [sub, value] of Object.entries(pkg.exports)) {
		if (typeof value === 'string') {
			collapsed[sub] = value
		} else if (value && typeof value === 'object') {
			const types = value.types
			const target = value.import || value.require || value.default
			collapsed[sub] = types ? { types, default: target } : { default: target }
		}
	}
	pkg.exports = collapsed
}

// Update legacy entry points so resolvers without exports support also work.
if (pkg.exports && pkg.exports['.']) {
	const root = pkg.exports['.']
	const rootEntry = typeof root === 'string' ? root : root.default
	if (rootEntry) pkg.main = rootEntry
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const pkgBareName = pkg.name.replace(/^@/, '').replace(/\//g, '-')
const tagName = `${pkgBareName}/${newVersion}`

try {
	// Pre-build steps that the upstream `prepublishOnly` would have run.
	// We do them here so we can pass `--ignore-scripts` to npm publish below
	// and prevent it from re-running `npm run build` (which would use the
	// wrong tsconfig and clobber our format-specific dist).
	if (pkg.scripts?.['generate-models']) {
		execSync('npm run generate-models', { stdio: 'inherit' })
	}
	execSync('npm run clean', { stdio: 'inherit' })
	execSync(`npx tsgo -p tsconfig.build.${format}.json`, { stdio: 'inherit' })

	execSync(`npm publish --tag ${format} --ignore-scripts`, { stdio: 'inherit' })
	execSync(`git tag ${tagName}`, { stdio: 'inherit' })
	execSync(`git push origin ${tagName}`, { stdio: 'inherit' })
	console.log(`\n✓ Published ${pkg.name}@${newVersion} (tag: ${format})`)
	console.log(`✓ Git tag pushed: ${tagName}`)
} finally {
	writeFileSync(pkgPath, original)
}
