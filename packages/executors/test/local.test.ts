import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Proc } from "@orc/core/src/contracts.js";
import { LocalExecutor } from "../src/local.js";
import { checkCwd, doctor } from "../src/doctor.js";
import { executorFor } from "../src/factory.js";
import { collectRun } from "../src/run.js";
import { SshExecutor } from "../src/ssh.js";

const local = new LocalExecutor();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe("LocalExecutor", () => {
  it("captures stdout and stderr separately", async () => {
    const { code, stdout, stderr } = await local.run(["sh", "-c", "echo out; echo err >&2"]);
    expect(code).toBe(0);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
  });

  it("reports exit codes", async () => {
    expect((await local.run(["sh", "-c", "exit 0"])).code).toBe(0);
    expect((await local.run(["sh", "-c", "exit 7"])).code).toBe(7);
  });

  it("resolves -1 for an unspawnable binary (never rejects)", async () => {
    const { code } = await local.run(["definitely-not-a-real-binary-orc"]);
    expect(code).toBe(-1);
  });

  it("respects cwd and env", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "orc-local-"));
    const { stdout } = await local.run(["sh", "-c", "pwd; printf %s \"$ORC_TEST_VAR\""], {
      cwd: dir,
      env: { ORC_TEST_VAR: "hello" },
    });
    expect(stdout.split("\n")[0]).toBe(await fs.realpath(dir));
    expect(stdout.endsWith("hello")).toBe(true);
  });

  it("kill() terminates the whole process group, including children", async () => {
    // The shell backgrounds one sleep and foregrounds another; group kill must
    // take out both. The background child's pid is printed for verification.
    const proc = local.spawn(["sh", "-c", "sleep 100 & echo $!; sleep 100"]);
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (out += d));
    await waitFor(() => out.includes("\n"), 5000);
    const childPid = Number(out.trim());
    expect(childPid).toBeGreaterThan(0);
    expect(pidAlive(childPid)).toBe(true);

    proc.kill();
    const code = await proc.exited;
    expect(code).toBe(-1); // died by signal
    expect(await waitFor(() => !pidAlive(childPid), 5000)).toBe(true);
  });

  it("kill() escalates against a TERM-ignoring descendant after its leader exits", async () => {
    // Vitest's own handles would mask an unref()'d escalation timer, so exercise
    // the lifecycle in a helper whose only remaining handle is that timer.
    const helper = nodeSpawn(
      process.execPath,
      ["--import", "tsx", join(fileURLToPath(new URL(".", import.meta.url)), "helpers", "kill-escalation.ts")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stdout.on("data", (data: string) => (stdout += data));
    helper.stderr.on("data", (data: string) => (stderr += data));
    let timeout: NodeJS.Timeout | undefined;

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`kill escalation helper timed out: ${stderr}`)), 5000);
        helper.once("error", reject);
        helper.once("exit", resolve);
      });
      const childPid = Number(stdout.trim());
      expect(code, stderr).toBe(0);
      expect(childPid).toBeGreaterThan(0);
      expect(pidAlive(childPid), "TERM-ignoring descendant leaked after helper exited").toBe(false);
    } finally {
      clearTimeout(timeout);
      helper.kill("SIGKILL");
      const childPid = Number(stdout.trim());
      if (childPid > 0 && pidAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("kill() is idempotent", async () => {
    const proc = local.spawn(["sleep", "60"]);
    proc.kill();
    proc.kill();
    expect(await proc.exited).toBe(-1);
  });

  it("run() timeoutMs kills the process and resolves -1", async () => {
    const start = Date.now();
    const { code } = await local.run(["sleep", "60"], { timeoutMs: 250 });
    expect(code).toBe(-1);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("readFile/writeFile/exists round-trip in a tmp dir", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "orc-localfs-"));
    const file = join(dir, "data.txt");
    expect(await local.exists(file)).toBe(false);
    const payload = "line1\nline2 with 'quotes' and $dollars\n";
    await local.writeFile(file, payload);
    expect(await local.exists(file)).toBe(true);
    expect(await local.readFile(file)).toBe(payload);
    expect(await checkCwd(local, dir)).toBe(true);
    expect(await checkCwd(local, join(dir, "missing"))).toBe(false);
  });
});

describe("collectRun", () => {
  it("waits for stdout and stderr bytes that arrive after process exit", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc: Proc = {
      stdin: null,
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill: () => {},
      pid: 12345,
    };
    setImmediate(() => {
      stdout.end("late stdout");
      stderr.end("late stderr");
    });

    await expect(collectRun(proc, { stdin: "ignore" })).resolves.toEqual({
      code: 0,
      stdout: "late stdout",
      stderr: "late stderr",
    });
  });

  it("honors the caller timeout while post-exit streams remain open", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc: Proc = {
      stdin: null,
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill: () => {},
      pid: 12345,
    };

    await expect(collectRun(proc, { stdin: "ignore", timeoutMs: 20 })).resolves.toEqual({
      code: -1,
      stdout: "",
      stderr: "",
    });
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
  });
});

describe("executorFor", () => {
  it("returns a cached LocalExecutor for undefined and SshExecutor per host", () => {
    const a = executorFor(undefined);
    expect(a.host).toBeUndefined();
    expect(executorFor(undefined)).toBe(a);
    const b = executorFor("frank");
    expect(b).toBeInstanceOf(SshExecutor);
    expect(b.host).toBe("frank");
    expect(executorFor("frank")).toBe(b);
    expect(executorFor("user@other")).not.toBe(b);
    expect(() => executorFor("-oProxyCommand=bad")).toThrow("SshExecutor: invalid destination");
  });
});

describe("doctor", () => {
  it("reports found binaries with versions and missing ones as not found", async () => {
    const report = await doctor(local, { harnesses: ["sh", "definitely-not-a-real-binary-orc"] });
    expect(report.host).toBeUndefined();
    const sh = report.harnesses.find((h) => h.name === "sh");
    expect(sh?.found).toBe(true);
    expect(sh?.path).toMatch(/\/sh$/);
    const missing = report.harnesses.find((h) => h.name === "definitely-not-a-real-binary-orc");
    expect(missing?.found).toBe(false);
  });
});
