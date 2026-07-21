import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import type { Executor, Proc, SpawnOptions } from "@karowanorg/orc-core";
import { collectRun } from "./run.js";

export interface LocalExecutorOptions {
  /** SIGTERM -> SIGKILL grace period for kill(). Default 5000ms. */
  killGraceMs?: number;
}

/**
 * Runs processes on the local host. Children are spawned `detached` so they
 * lead their own process group; kill() signals the whole group (SIGTERM,
 * then SIGKILL after a grace period) so grandchildren cannot leak.
 */
export class LocalExecutor implements Executor {
  readonly host: string | undefined = undefined;
  private readonly killGraceMs: number;

  constructor(opts?: LocalExecutorOptions) {
    this.killGraceMs = opts?.killGraceMs ?? 5000;
  }

  spawn(cmd: string[], opts?: SpawnOptions): Proc {
    if (cmd.length === 0) throw new Error("spawn: empty command");
    const child = nodeSpawn(cmd[0], cmd.slice(1), {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      detached: true, // own process group => group-wide kill
      stdio: [opts?.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const exited = new Promise<number>((resolve) => {
      child.once("error", () => resolve(-1)); // e.g. ENOENT; never rejects
      child.once("exit", (code) => resolve(code ?? -1)); // null code => signal
    });

    let killed = false;
    const graceMs = this.killGraceMs;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      const pid = child.pid;
      if (pid === undefined) return; // spawn failed; nothing to signal
      const signalGroup = (sig: NodeJS.Signals): void => {
        try {
          process.kill(-pid, sig); // negative pid => whole process group
        } catch {
          try {
            child.kill(sig); // group already gone; try the leader directly
          } catch {
            /* already dead */
          }
        }
      };
      signalGroup("SIGTERM");
      const escalate = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      // The process-group leader can exit while TERM-ignoring descendants live.
      // Keep escalation alive only while that group still exists.
      void exited.then(() => {
        try {
          process.kill(-pid, 0);
        } catch {
          clearTimeout(escalate);
        }
      });
    };

    return {
      stdin: child.stdin,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exited,
      kill,
      pid: child.pid,
    };
  }

  async run(
    cmd: string[],
    opts?: SpawnOptions & { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return collectRun(this.spawn(cmd, opts), opts);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(path, "utf8");
  }

  async writeFile(path: string, data: string): Promise<void> {
    await fs.writeFile(path, data, "utf8");
  }
}
