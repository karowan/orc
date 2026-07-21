import { finished } from "node:stream/promises";
import type { Proc, SpawnOptions } from "@orc/core/src/contracts.js";

const STREAM_DRAIN_TIMEOUT_MS = 10_000;

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

  const labeled = (name: string, done: Promise<void>): Promise<void> =>
    done.catch((error: unknown) => {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
  const streams = [
    labeled(
      "stdout",
      finished(proc.stdout, {
        readable: true,
        writable: false,
      }),
    ),
    labeled(
      "stderr",
      finished(proc.stderr, {
        readable: true,
        writable: false,
      }),
    ),
  ];
  if (proc.stdin && opts?.stdin !== "ignore") {
    streams.push(
      labeled(
        "stdin",
        finished(proc.stdin, {
          readable: false,
          writable: true,
        }),
      ),
    );
  }
  const streamsDone = Promise.all(streams);
  void streamsDone.catch(() => proc.kill());

  // No input to provide: close stdin so `cat`-style commands terminate.
  if (proc.stdin && opts?.stdin !== "ignore") proc.stdin.end();

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let timeoutReached: Promise<void> | undefined;
  if (typeof opts?.timeoutMs === "number") {
    timeoutReached = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve();
      }, opts.timeoutMs);
    });
  }
  const destroyStreams = () => {
    proc.stdin?.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
  };
  try {
    const code = await proc.exited;
    // tradeoff: a descendant may flush inherited pipes for up to this fixed
    // grace; make it configurable if longer post-leader output becomes valid.
    const drain = await Promise.race([
      streamsDone.then(() => "done" as const),
      ...(timeoutReached ? [timeoutReached.then(() => "timeout" as const)] : []),
      new Promise<"stalled">((resolve) => {
        drainTimer = setTimeout(() => resolve("stalled"), STREAM_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (drain === "timeout") {
      destroyStreams();
      return { code: -1, stdout, stderr };
    }
    if (drain === "stalled") {
      proc.kill();
      destroyStreams();
      throw new Error(
        `process streams did not close within ${STREAM_DRAIN_TIMEOUT_MS}ms after exit`,
      );
    }
    return { code: timedOut ? -1 : code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    if (drainTimer) clearTimeout(drainTimer);
  }
}
