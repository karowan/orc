import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Proc, SpawnOptions } from "@orc/core";
import { LocalExecutor } from "../src/local.js";
import { shQuote } from "../src/shquote.js";
import { SshExecutor } from "../src/ssh.js";

interface FakeCall {
  cmd: string[];
  opts: SpawnOptions | undefined;
  stdinData: string;
}

/** Fake spawn seam: records argv, scripts exit code/stdout, captures stdin. */
function fakeSpawner(script?: { code?: number; stdout?: string; stderr?: string }) {
  const calls: FakeCall[] = [];
  let killed = 0;
  const spawnImpl = (cmd: string[], opts?: SpawnOptions): Proc => {
    const call: FakeCall = { cmd, opts, stdinData: "" };
    calls.push(call);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (d) => (call.stdinData += d.toString()));
    const exited = new Promise<number>((resolve) => {
      stdin.on("finish", () => {
        if (script?.stdout) stdout.end(script.stdout);
        else stdout.end();
        if (script?.stderr) stderr.end(script.stderr);
        else stderr.end();
        resolve(script?.code ?? 0);
      });
    });
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: () => {
        killed += 1;
        stdin.end();
      },
      pid: 12345,
    };
  };
  return { spawnImpl, calls, killedCount: () => killed };
}

describe("SshExecutor command construction", () => {
  it("wraps commands in ssh + login shell with BatchMode", () => {
    const ssh = new SshExecutor("frank", { spawnImpl: fakeSpawner().spawnImpl });
    const argv = ssh.sshArgv(["echo", "hello world"]);
    expect(argv.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-T", "--", "frank"]);
    expect(argv.slice(6, 8)).toEqual(["zsh", "-lc"]);
    // The zsh -lc payload is quoted once more for the remote login shell's
    // outer parse; unwrapping one layer must yield the exec line.
    expect(argv).toHaveLength(9);
    expect(argv.at(-1)).toBe(shQuote(`exec 'echo' 'hello world'`));
  });

  it.each([
    `-oProxyCommand=sh -c "echo injected"`,
    "host\n-oProxyCommand=bad",
    "host\u0000bad",
    "host\u007fbad",
    "host\u0085bad",
  ])("rejects an option-like or control-character destination: %j", (destination) => {
    expect(() => new SshExecutor(destination)).toThrow("SshExecutor: invalid destination");
  });

  it("builds cd-prefixed remote commands with escaping", () => {
    const ssh = new SshExecutor("user@host", { spawnImpl: fakeSpawner().spawnImpl });
    expect(ssh.remoteCommand(["ls", "-la"], "/tmp/o dir")).toBe(
      `cd '/tmp/o dir' && exec 'ls' '-la'`,
    );
    expect(ssh.remoteCommand(["printf", "%s", "a'b"])).toBe(
      `exec 'printf' '%s' 'a'\\''b'`,
    );
    expect(ssh.remoteCommand(["run"], undefined, { KEY: "v al$ue" })).toBe(
      `exec 'env' 'KEY=v al$ue' 'run'`,
    );
  });

  it("spawn passes cwd/env into the remote argv, not the local ssh process", () => {
    const fake = fakeSpawner();
    const ssh = new SshExecutor("frank", { spawnImpl: fake.spawnImpl });
    ssh.spawn(["ls"], { cwd: "/work", env: { A: "1" } });
    expect(fake.calls).toHaveLength(1);
    const { cmd, opts } = fake.calls[0];
    expect(cmd.at(-1)).toBe(shQuote("cd '/work' && exec 'env' 'A=1' 'ls'"));
    expect(opts?.cwd).toBeUndefined();
    expect(opts?.env).toBeUndefined();
  });

  it("exists() maps test -e exit codes", async () => {
    const hit = new SshExecutor("frank", { spawnImpl: fakeSpawner({ code: 0 }).spawnImpl });
    expect(await hit.exists("/etc/hosts")).toBe(true);
    const miss = new SshExecutor("frank", { spawnImpl: fakeSpawner({ code: 1 }).spawnImpl });
    expect(await miss.exists("/nope")).toBe(false);
  });

  it("readFile cats the remote path and throws on failure", async () => {
    const ok = fakeSpawner({ code: 0, stdout: "contents\n" });
    const ssh = new SshExecutor("frank", { spawnImpl: ok.spawnImpl });
    expect(await ssh.readFile("/tmp/x")).toBe("contents\n");
    expect(ok.calls[0].cmd.at(-1)).toBe(shQuote("exec 'cat' '/tmp/x'"));

    const bad = fakeSpawner({ code: 1, stderr: "cat: /tmp/x: No such file" });
    const sshBad = new SshExecutor("frank", { spawnImpl: bad.spawnImpl });
    await expect(sshBad.readFile("/tmp/x")).rejects.toThrow(/No such file/);
  });

  it("writeFile pipes data to a remote cat > path", async () => {
    const fake = fakeSpawner({ code: 0 });
    const ssh = new SshExecutor("frank", { spawnImpl: fake.spawnImpl });
    await ssh.writeFile("/tmp/out file", "payload\nwith 'quotes'\n");
    expect(fake.calls).toHaveLength(1);
    const innerRedirect = `cat > ${shQuote("/tmp/out file")}`;
    expect(fake.calls[0].cmd.at(-1)).toBe(
      shQuote(ssh.remoteCommand(["sh", "-c", innerRedirect])),
    );
    expect(fake.calls[0].stdinData).toBe("payload\nwith 'quotes'\n");
  });

  it("writeFile reports stdin EPIPE after draining remote stderr", async () => {
    let resolveExit!: (code: number) => void;
    let killed = 0;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const spawnImpl = (): Proc => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          setImmediate(() => {
            stdout.end();
            stderr.end("remote cat failed");
            resolveExit(1);
          });
        },
      });
      return { stdin, stdout, stderr, exited, kill: () => { killed++; }, pid: 12345 };
    };
    const ssh = new SshExecutor("frank", { spawnImpl });

    await expect(ssh.writeFile("/tmp/out", "payload")).rejects.toThrow(
      /remote cat failed; stdin: write EPIPE/,
    );
    expect(killed).toBe(0);
  });

  it("run reports remote stderr stream errors", async () => {
    const spawnImpl = (): Proc => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exited = new Promise<number>((resolve) => {
        stdin.once("finish", () => {
          setImmediate(() => {
            stdout.end();
            stderr.destroy(new Error("read EPIPE"));
            resolve(255);
          });
        });
      });
      return { stdin, stdout, stderr, exited, kill: () => {}, pid: 12345 };
    };
    const ssh = new SshExecutor("frank", { spawnImpl });

    await expect(ssh.run(["true"])).rejects.toThrow(/stderr: read EPIPE/);
  });

  it("kill() kills the local ssh process (channel teardown)", async () => {
    const fake = fakeSpawner();
    const ssh = new SshExecutor("frank", { spawnImpl: fake.spawnImpl });
    const proc = ssh.spawn(["sleep", "100"]);
    proc.kill();
    expect(fake.killedCount()).toBe(1);
    await proc.exited;
  });

  it("remote quoting survives a real local-shell round trip", async () => {
    // Simulate the remote login shell locally: run the exact zsh -lc payload
    // ssh would send, and confirm the nasty string survives both quote layers.
    const local = new LocalExecutor();
    const ssh = new SshExecutor("frank", { spawnImpl: fakeSpawner().spawnImpl });
    const nasty = `=ls^a'b"c$d\`e f\ng`;
    const argv = ssh.sshArgv(["printf", "%s", nasty]);
    const payload = argv.slice(-3).join(" "); // zsh -lc '<quoted>'
    const { code, stdout } = await local.run(["zsh", "-f", "-c", payload]);
    expect(code).toBe(0);
    expect(stdout).toBe(nasty);
  });
});
