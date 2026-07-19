import { build } from "esbuild";
import * as fs from "node:fs";
import { sha256Hex } from "./canonical.js";

/**
 * Compile a .orc.ts / .ts / .js program into a frozen single-file bundle.
 * The emitted bytes are the pinned program: sha256(bundle) goes in the manifest
 * and every execution (live or replay) runs exactly these bytes.
 *
 * Programs may use `import type` freely (erased); runtime imports are rejected
 * (the sandbox has no module loader).
 */
export async function compileProgram(entryPath: string): Promise<{ bundle: string; sha256: string }> {
  if (!fs.existsSync(entryPath)) throw new Error(`program not found: ${entryPath}`);
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    globalName: "__orc_mod",
    platform: "neutral",
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  const bundle = result.outputFiles[0].text;
  return { bundle, sha256: sha256Hex(bundle) };
}
