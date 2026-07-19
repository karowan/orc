import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { orcHome } from "./rundir.js";
import type { ExtensionLeaf, Harness } from "./contracts.js";
import type { ModelRate } from "./cost.js";

/**
 * Optional config. Zero config is the default: built-ins (claude, codex) are
 * discovered natively; there is deliberately NO ambient plugin scanning —
 * registering a custom harness or extension is an explicit config entry.
 */
export interface OrcConfig {
  /** Custom harnesses: Harness objects, or { exec } NDJSON executables. */
  harnesses?: Array<Harness | { exec: string; name?: string }>;
  defaultHarness?: string;
  extensions?: ExtensionLeaf[];
  /** Per-model USD/1M rate overrides for cost estimation (codex). */
  costRates?: Record<string, ModelRate>;
}

/** Identity helper with types — `defineLeaf({...})` in orc.config.js. */
export function defineLeaf(leaf: ExtensionLeaf): ExtensionLeaf {
  return leaf;
}

const CONFIG_BASENAMES = ["orc.config.js", "orc.config.mjs", "orc.config.json"];

export async function loadConfig(cwd: string): Promise<OrcConfig> {
  for (const dir of [cwd, orcHome()]) {
    for (const base of CONFIG_BASENAMES) {
      const file = path.join(dir, base);
      if (!fs.existsSync(file)) continue;
      if (base.endsWith(".json")) {
        return JSON.parse(fs.readFileSync(file, "utf8")) as OrcConfig;
      }
      const mod = (await import(pathToFileURL(file).href)) as { default?: OrcConfig };
      return mod.default ?? {};
    }
  }
  return {};
}

/**
 * Caller-affinity default harness: an orchestration launched from a claude
 * session defaults to claude leaves; from codex, codex. Resolution order is
 * per-call harness → launch flag → config.defaultHarness → caller affinity →
 * codex → any available. `mcpClientName` lets the MCP head pass clientInfo.
 */
export function callerAffinity(mcpClientName?: string): string | undefined {
  const name = (mcpClientName ?? "").toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME || process.env.CODEX_CI) return "codex";
  return undefined;
}
