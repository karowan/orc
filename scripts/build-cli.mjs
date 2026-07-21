// Bundle the orc CLI into a single self-contained ESM file for global install.
// Native / wasm / CLI-spawning deps stay external (installed as real modules).
import { build } from "esbuild";
import { writeFileSync, chmodSync } from "node:fs";

const external = [
  "esbuild",            // native binary; used to compile programs at launch
  "quickjs-emscripten", // ships a wasm module loaded at runtime
  // NOTE: @anthropic-ai/claude-agent-sdk is intentionally BUNDLED (its 4MB of JS)
  // so we never pull its ~236MB per-platform CLI binaries. orc points the SDK at
  // the system `claude` (a prerequisite) via pathToClaudeCodeExecutable.
];

await build({
  entryPoints: ["packages/cli/src/bin.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist-cli/orc.mjs",
  external,
  // Shebang + a require shim so bundled CommonJS deps (commander) can require()
  // node builtins under ESM output.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);\n",
  },
  // @karowanorg/orc-* and the deep ./src/*.ts imports resolve to real TS and get bundled.
  logLevel: "info",
});
chmodSync("dist-cli/orc.mjs", 0o755);

const version = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync("package.json"))).version ?? "0.1.0";
writeFileSync(
  "dist-cli/package.json",
  JSON.stringify(
    {
      name: "orc",
      version: "0.1.0",
      description: "orc — model-authored orchestration runs",
      type: "module",
      bin: { orc: "orc.mjs" },
      engines: { node: ">=22" },
      dependencies: {
        esbuild: "^0.25.0",
        "quickjs-emscripten": "^0.31.0",
      },
    },
    null,
    2,
  ) + "\n",
);
console.log("built dist-cli/orc.mjs + package.json");
