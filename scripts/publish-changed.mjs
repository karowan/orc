#!/usr/bin/env node
// Publish every workspace whose package.json version is not on the npm
// registry yet, in dependency order. Idempotent: a re-run after a partial
// publish only picks up what is still missing.
//
//   node scripts/publish-changed.mjs           # publish (CI runs this via `npm run release`)
//   node scripts/publish-changed.mjs --plan    # list what would publish; publish nothing
//   node scripts/publish-changed.mjs --dry-run # npm publish --dry-run per package
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const plan = args.has("--plan");
const dryRun = args.has("--dry-run");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Workspace directories from the root manifest (`packages/*` style globs).
const workspaceDirs = readJson(path.join(root, "package.json")).workspaces.flatMap((pattern) => {
  if (!pattern.endsWith("/*")) return [path.join(root, pattern)];
  const parent = path.join(root, pattern.slice(0, -2));
  return readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(parent, d.name));
});
const packages = workspaceDirs
  .filter((dir) => existsSync(path.join(dir, "package.json")))
  .map((dir) => readJson(path.join(dir, "package.json")))
  .filter((pkg) => !pkg.private);

function publishedVersions(name) {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed]; // a single-version package comes back as a string
  } catch (err) {
    if (`${err.stdout ?? ""}${err.stderr ?? ""}`.includes("E404")) return []; // never published
    throw err;
  }
}

// Dependencies before dependents, so a consumer never lands before what it needs.
function inDependencyOrder(list) {
  const byName = new Map(list.map((pkg) => [pkg.name, pkg]));
  const ordered = [];
  const seen = new Set();
  const visit = (pkg) => {
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
      const internal = byName.get(dep);
      if (internal) visit(internal);
    }
    ordered.push(pkg);
  };
  list.forEach(visit);
  return ordered;
}

const pending = inDependencyOrder(packages).filter((pkg) => !publishedVersions(pkg.name).includes(pkg.version));

if (pending.length === 0) console.log("nothing to publish: every workspace version is already on the registry");
for (const pkg of pending) console.log(`${plan ? "would publish" : "publishing"} ${pkg.name}@${pkg.version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${pending.length}\n`);
if (plan) process.exit(0);

for (const pkg of pending) {
  const npmArgs = ["publish", "--workspace", pkg.name, "--access", "public"];
  // In CI: provenance, and verbose logs so a refused OIDC token exchange shows
  // its real reason instead of surfacing as a bare ENEEDAUTH.
  if (process.env.GITHUB_ACTIONS === "true") npmArgs.push("--provenance", "--loglevel=verbose");
  if (dryRun) npmArgs.push("--dry-run");
  execFileSync("npm", npmArgs, { cwd: root, stdio: "inherit" });
}
