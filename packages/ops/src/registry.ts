/**
 * Registry assembly — zero-config by default: built-ins (claude, codex) are
 * registered unconditionally and probed natively at capability time. There is
 * deliberately NO ambient plugin scanning; custom harnesses and extensions
 * come only from an explicit orc.config.(js|json).
 */
import { callerAffinity, loadConfig, type Harness, type OrcConfig } from "@orc/core";
import type { Registry } from "@orc/core";
import { LocalExecutor } from "@orc/executors";
import { claudeHarness } from "@orc/harness-claude";
import { codexHarness, createCodexHarness } from "@orc/harness-codex";
import { makeExecHarness } from "./exec-harness.js";

export interface RegistryOptions {
  cwd?: string;
  mcpClientName?: string;
  defaultHarness?: string;
}

export async function buildRegistry(opts: RegistryOptions = {}): Promise<Registry> {
  const config: OrcConfig = await loadConfig(opts.cwd ?? process.cwd());
  const harnesses = new Map<string, Harness>();
  harnesses.set(claudeHarness.name, claudeHarness);
  // Codex needs a cost-rate table (it reports tokens, not dollars); pass config
  // overrides through, else the built-in default is used.
  const codex = config.costRates ? createCodexHarness({ costRates: config.costRates }) : codexHarness;
  harnesses.set(codex.name, codex);
  for (const entry of config.harnesses ?? []) {
    if ("exec" in entry) {
      const h = makeExecHarness(entry.exec, entry.name);
      harnesses.set(h.name, h);
    } else {
      harnesses.set(entry.name, entry);
    }
  }
  const extensions = new Map((config.extensions ?? []).map((e) => [e.name, e]));
  const defaultHarness =
    opts.defaultHarness ??
    config.defaultHarness ??
    callerAffinity(opts.mcpClientName) ??
    "codex";
  return { harnesses, extensions, defaultHarness, executor: new LocalExecutor() };
}
