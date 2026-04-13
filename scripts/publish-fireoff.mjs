#!/usr/bin/env node
// Publishes @synix/pi-ai and @synix/pi-agent-core to GitHub Packages
// without modifying source code or workspace package names.
//
// At publish time it temporarily rewrites each target package.json:
//   - name: @mariozechner/* -> @synix/*
//   - version: <base> -> <base>-fireoff.<N>
//   - repository.url: badlogic/pi-mono -> synix/pi-mono
//   - publishConfig: GitHub Packages registry, public access
//   - dependencies on @mariozechner/pi-* are converted to npm: aliases
//     so downstream installs of @synix/pi-agent-core resolve the alias
//     to @synix/pi-ai and place it under node_modules/@mariozechner/pi-ai/,
//     keeping our source-level imports working.
//
// On success or failure, the original package.json files are restored.
//
// Required env: NODE_AUTH_TOKEN (GitHub PAT with write:packages).
//
// Usage:
//   node scripts/publish-fireoff.mjs            # real publish
//   node scripts/publish-fireoff.mjs --dry-run  # dry-run

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const PUBLISH_NAME_MAP = {
	"@mariozechner/pi-ai": "@synix/pi-ai",
	"@mariozechner/pi-agent-core": "@synix/pi-agent-core",
};
const TARGETS = ["packages/ai", "packages/agent"];
const FORK_REPO_URL = "git+https://github.com/synix/pi-mono.git";
const TAG = "fireoff";

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
	console.error("ERROR: NODE_AUTH_TOKEN is not set. Export a GitHub PAT with write:packages scope.");
	process.exit(1);
}

const counter = Number((readFileSync(join(root, ".fireoff-version"), "utf8") || "0").trim());

const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const write = (p, data) => writeFileSync(join(root, p), `${JSON.stringify(data, null, "\t")}\n`);

function rewrite(pkgPath) {
	const original = readFileSync(join(root, pkgPath), "utf8");
	const pkg = JSON.parse(original);
	const newName = PUBLISH_NAME_MAP[pkg.name];
	if (!newName) throw new Error(`No publish mapping for ${pkg.name}`);

	const publishVersion = `${pkg.version}-fireoff.${counter}`;
	pkg.name = newName;
	pkg.version = publishVersion;
	pkg.publishConfig = { registry: "https://npm.pkg.github.com", access: "public" };
	if (pkg.repository?.url) pkg.repository.url = FORK_REPO_URL;

	for (const section of ["dependencies", "peerDependencies"]) {
		const deps = pkg[section];
		if (!deps) continue;
		for (const [depName] of Object.entries(deps)) {
			const aliased = PUBLISH_NAME_MAP[depName];
			if (aliased) {
				deps[depName] = `npm:${aliased}@${publishVersion}`;
			}
		}
	}

	write(pkgPath, pkg);
	return { pkgPath, original, publishVersion, newName };
}

const backups = [];
let publishError = null;

try {
	// Build with ORIGINAL package.json so workspace links resolve to @mariozechner/pi-ai.
	const buildCmd = `npm run build ${TARGETS.map((d) => `-w ${d}`).join(" ")}`;
	console.log(`\n$ ${buildCmd}\n`);
	execSync(buildCmd, { stdio: "inherit", cwd: root });

	// Rewrite for publish (changes name, version, deps to npm: aliases).
	for (const dir of TARGETS) {
		const info = rewrite(`${dir}/package.json`);
		backups.push(info);
		console.log(`prepared: ${info.newName}@${info.publishVersion}`);
	}

	// --ignore-scripts skips prepublishOnly (we already built above).
	const wsArgs = TARGETS.map((d) => `-w ${d}`).join(" ");
	const cmd = `npm publish --ignore-scripts --tag ${TAG} ${wsArgs}${dryRun ? " --dry-run" : ""}`;
	console.log(`\n$ ${cmd}\n`);
	execSync(cmd, { stdio: "inherit", cwd: root });
} catch (e) {
	publishError = e;
} finally {
	for (const b of backups) {
		writeFileSync(join(root, b.pkgPath), b.original);
	}
	console.log("\nrestored original package.json files");
}

if (publishError) {
	console.error("\npublish failed");
	process.exit(1);
}

if (!dryRun) {
	console.log("\n✅ published. Bumping counter for next time.");
	writeFileSync(join(root, ".fireoff-version"), `${counter + 1}\n`);
}
