import type { Executor } from "@orc/core/src/contracts.js";

export interface HarnessBinaryReport {
  name: string;
  found: boolean;
  /** Resolved binary path when found. */
  path?: string;
  /** Output of `<bin> --version` when found. */
  version?: string;
  error?: string;
}

export interface DoctorReport {
  harnesses: HarnessBinaryReport[];
}

const CHECK_TIMEOUT_MS = 15_000;

/**
 * Check that each named harness binary (e.g. "claude", "codex") resolves on
 * PATH and report its version.
 */
export async function doctor(
  executor: Executor,
  opts: { harnesses: string[] },
): Promise<DoctorReport> {
  const harnesses: HarnessBinaryReport[] = [];
  for (const name of opts.harnesses) {
    try {
      const which = await executor.run(["which", name], { timeoutMs: CHECK_TIMEOUT_MS });
      if (which.code !== 0) {
        harnesses.push({ name, found: false, error: `not found on PATH` });
        continue;
      }
      const path = which.stdout.trim().split("\n").pop() ?? "";
      const ver = await executor.run([name, "--version"], { timeoutMs: CHECK_TIMEOUT_MS });
      harnesses.push({
        name,
        found: true,
        path,
        version: ver.code === 0 ? (ver.stdout.trim() || ver.stderr.trim()) : undefined,
        error: ver.code === 0 ? undefined : `--version exited ${ver.code}`,
      });
    } catch (err) {
      harnesses.push({ name, found: false, error: String(err) });
    }
  }
  return { harnesses };
}

/** Does the given working directory exist? */
export async function checkCwd(executor: Executor, cwd: string): Promise<boolean> {
  return executor.exists(cwd);
}
