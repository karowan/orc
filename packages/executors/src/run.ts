import type { Proc, SpawnOptions } from "@orc/core/src/contracts.js";

/**
 * Shared `run()` implementation: collect stdout/stderr from a Proc until exit,
 * with an optional timeout that kills the process (group) and resolves -1.
 */
export async function collectRun(
  proc: Proc,
  opts?: SpawnOptions & { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => (stdout += d));
  proc.stderr.on("data", (d: string) => (stderr += d));
  // No input to provide: close stdin so remote `cat`-style commands terminate.
  if (proc.stdin && opts?.stdin !== "ignore") proc.stdin.end();

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (typeof opts?.timeoutMs === "number") {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }
  try {
    const code = await proc.exited;
    return { code: timedOut ? -1 : code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
