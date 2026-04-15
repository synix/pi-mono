#!/usr/bin/env node
// Bumps the fireoff suffix counter stored in .fireoff-version.
// The publish-fireoff.mjs script reads this counter to compute the published version.
//
// Usage:
//   node scripts/bump-fireoff.mjs           # increments counter by 1
//   node scripts/bump-fireoff.mjs --reset   # resets counter to 0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(process.cwd(), ".fireoff-version");
const args = process.argv.slice(2);

const current = Number((readFileSync(file, "utf8") || "0").trim());
const next = args.includes("--reset") ? 0 : current + 1;

writeFileSync(file, `${next}\n`);
console.log(`fireoff counter: ${current} → ${next}`);
console.log(`next publish will be x.y.z-fireoff.${next}`);
