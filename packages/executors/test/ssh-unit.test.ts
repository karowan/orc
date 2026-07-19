import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Proc, SpawnOptions } from "@orc/core/src/contracts.js";
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
    expect(argv.slice(0, 4)).toEqual(["ssh", "-o", "BatchMode=yes", "frank"]);
    expect(argv.slice(4, 6)).toEqual(["zsh", "-lc"]);
    // The zsh -lc payload is quoted once more for the remote login shell's
    // outer parse; unwrapping one layer must yield the exec line.
    expect(argv).toHaveLength(7);
    expect(argv[6]).toBe(shQuote(`exec echo 'hello world'`));
  });

  it("builds cd-prefixed remote commands with escaping", () => {
    const ssh = new SshExecutor("user@host", { spawnImpl: fakeSpawner().spawnImpl });
    expect(ssh.remoteCommand(["ls", "-la"], "/tmp/o dir")).toBe(`cd '/tmp/o dir' && exec ls -la`);
    expect(ssh.remoteCommand(["printf", "%s", "a'b"])).toBe(`exec printf %s 'a'\\''b'`);
    expect(ssh.remoteCommand(["run"], undefined, { KEY: "v al$ue" })).toBe(
      `exec env 'KEY=v al$ue' run`,
    );
  });

  it("spawn passes cwd/env into the remote argv, not the local ssh process", () => {
    const fake = fakeSpawner();
    const ssh = new SshExecutor("frank", { spawnImpl: fake.spawnImpl });
    ssh.spawn(["ls"], { cwd: "/work", env: { A: "1" } });
    expect(fake.calls).toHaveLength(1);
    const { cmd, opts } = fake.calls[0];
    expect(cmd[6]).toBe(shQuote("cd /work && exec env A=1 ls"));
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
    expect(ok.calls[0].cmd[6]).toBe(shQuote("exec cat /tmp/x"));

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
    expect(fake.calls[0].cmd[6]).toBe(shQuote(`exec sh -c ${shQuote(innerRedirect)}`));
    expect(fake.calls[0].stdinData).toBe("payload\nwith 'quotes'\n");
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
    const nasty = `a'b"c$d\`e f\ng`;
    const argv = ssh.sshArgv(["printf", "%s", nasty]);
    const payload = argv.slice(4).join(" "); // zsh -lc '<quoted>'
    const { code, stdout } = await local.run(["sh", "-c", payload]);
    expect(code).toBe(0);
    expect(stdout).toBe(nasty);
  });
});
