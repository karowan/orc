import type { Executor, Proc, SpawnOptions } from "@orc/core/src/contracts.js";
import { LocalExecutor } from "./local.js";
import { collectRun } from "./run.js";
import { shJoin, shQuote } from "./shquote.js";

export interface SshExecutorOptions {
  /**
   * Test seam: how to spawn the *local* ssh process. Defaults to a
   * LocalExecutor, whose kill() takes down the local ssh process group,
   * closing the channel and terminating the remote command.
   */
  spawnImpl?: (cmd: string[], opts?: SpawnOptions) => Proc;
  /** Extra ssh CLI options (inserted before the destination). */
  sshOptions?: string[];
}

/**
 * Runs commands on a remote host via the system `ssh` binary, so
 * ~/.ssh/config, agents, and ProxyJump all work for free.
 *
 * Non-interactive ssh gets a bare PATH, so every remote command is wrapped in
 * a login shell: `ssh -o BatchMode=yes <dest> zsh -lc '<escaped command>'`.
 */
export class SshExecutor implements Executor {
  readonly host: string;
  private readonly spawnImpl: (cmd: string[], opts?: SpawnOptions) => Proc;
  private readonly sshOptions: string[];

  constructor(destination: string, opts?: SshExecutorOptions) {
    if (!destination) throw new Error("SshExecutor: empty destination");
    this.host = destination;
    const local = new LocalExecutor();
    this.spawnImpl = opts?.spawnImpl ?? ((cmd, o) => local.spawn(cmd, o));
    this.sshOptions = opts?.sshOptions ?? [];
  }

  /**
   * Build the remote shell command string: `cd <cwd> && exec env K=V <cmd...>`
   * with every element POSIX-escaped. Exposed for unit tests.
   */
  remoteCommand(cmd: string[], cwd?: string, env?: Record<string, string>): string {
    if (cmd.length === 0) throw new Error("remoteCommand: empty command");
    const argv =
      env && Object.keys(env).length > 0
        ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...cmd]
        : cmd;
    const run = `exec ${shJoin(argv)}`;
    return cwd !== undefined ? `cd ${shQuote(cwd)} && ${run}` : run;
  }

  /** Full local argv for the ssh process. Exposed for unit tests. */
  sshArgv(cmd: string[], cwd?: string, env?: Record<string, string>): string[] {
    return [
      "ssh",
      "-o",
      "BatchMode=yes",
      ...this.sshOptions,
      this.host,
      // The remote login shell splits/reparses this line, so quote the whole
      // zsh -lc payload once more for that outer parse.
      "zsh",
      "-lc",
      shQuote(this.remoteCommand(cmd, cwd, env)),
    ];
  }

  spawn(cmd: string[], opts?: SpawnOptions): Proc {
    // cwd/env apply to the REMOTE command (encoded in the argv), never to the
    // local ssh process.
    return this.spawnImpl(this.sshArgv(cmd, opts?.cwd, opts?.env), { stdin: opts?.stdin });
  }

  async run(
    cmd: string[],
    opts?: SpawnOptions & { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return collectRun(this.spawn(cmd, opts), opts);
  }

  async exists(path: string): Promise<boolean> {
    const { code } = await this.run(["test", "-e", path]);
    return code === 0;
  }

  async readFile(path: string): Promise<string> {
    const { code, stdout, stderr } = await this.run(["cat", path]);
    if (code !== 0) {
      throw new Error(`ssh ${this.host}: cat ${path} failed (${code}): ${stderr.trim()}`);
    }
    return stdout;
  }

  async writeFile(path: string, data: string): Promise<void> {
    // Pipe the data through stdin into a remote `cat > path`.
    const proc = this.spawn(["sh", "-c", `cat > ${shQuote(path)}`]);
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => (stderr += d));
    proc.stdout.resume();
    if (!proc.stdin) throw new Error("ssh writeFile: stdin unavailable");
    proc.stdin.write(data);
    proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`ssh ${this.host}: write ${path} failed (${code}): ${stderr.trim()}`);
    }
  }
}
