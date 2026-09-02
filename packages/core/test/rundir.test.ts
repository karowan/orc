import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { RunManifest } from "../src/contracts.js";
import {
  JsonlAppender,
  acquireLock,
  appendPgid,
  createRunDir,
  livePgids,
  newRunId,
  readJsonl,
  JsonlTail,
  readManifest,
  readSupervisorPid,
  runPaths,
  writeSupervisorPid,
} from "../src/rundir.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.ORC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-rundir-"));
  process.env.ORC_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function manifest(runId: string, name = "first"): RunManifest {
  return {
    runId,
    name,
    programPath: "/tmp/program.orc.ts",
    programSha256: "0".repeat(64),
    cwd: "/tmp",
    context: "test",
    allowWrites: false,
    approvalMode: "auto",
    sandbox: false,
    sandboxDirs: [],
    networkAccess: false,
    maxParallel: 1,
    idleTimeoutMs: false,
    defaultHarness: "fake",
    createdAtMs: 1,
    orcVersion: "0.1.0",
  };
}

function emptyRun(runId: string) {
  const paths = runPaths(runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  return paths;
}

async function waitForFiles(files: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (files.every((file) => fs.existsSync(file))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${files.join(", ")}`);
}

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
}

describe("run directory identity", () => {
  it("uses a crypto-shaped id and never overwrites an existing run directory", () => {
    expect(newRunId("My Run!")).toMatch(/^r_my-run_[0-9a-f]{16}$/);

    const first = manifest("r_existing_id");
    const paths = createRunDir(first, "first bundle");
    expect(readManifest(first.runId)).toEqual(first);

    expect(() => createRunDir(manifest(first.runId, "second"), "second bundle")).toThrow();
    expect(fs.readFileSync(paths.program, "utf8")).toBe("first bundle");
    expect(readManifest(first.runId).name).toBe("first");
  });
});

describe("JSONL crash recovery", () => {
  it("truncates an unterminated tail before appending the next record", () => {
    const file = path.join(home, "records.jsonl");
    fs.writeFileSync(file, '{"n":1}\n{"n":2');

    const out = new JsonlAppender<{ n: number }>(file);
    out.append({ n: 3 }, { fsync: false });
    out.close();

    expect(fs.readFileSync(file, "utf8")).toBe('{"n":1}\n{"n":3}\n');
    expect(readJsonl<{ n: number }>(file)).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it("ignores only the current unterminated fragment and rejects committed corruption", () => {
    const file = path.join(home, "records.jsonl");
    fs.writeFileSync(file, '{"n":1}\n{"n":');
    expect(readJsonl<{ n: number }>(file)).toEqual([{ n: 1 }]);
    fs.writeFileSync(file, '{"n":9}');
    expect(readJsonl<{ n: number }>(file)).toEqual([]);

    fs.writeFileSync(file, '{"n":1}\nnot-json\n{"n":2}\n');
    expect(() => readJsonl(file)).toThrow(/line 2/);

    fs.writeFileSync(file, '{"n":1}\nnot-json\n');
    expect(() => readJsonl(file)).toThrow(/line 2/);
  });

  it("finishes a record when writeSync reports short writes", () => {
    const file = path.join(home, "records.jsonl");
    const originalWriteSync = fsDefault.writeSync;
    let writes = 0;
    fsDefault.writeSync = ((...args: unknown[]) => {
      const [fd, buffer, offset, length, position] = args as [number, Buffer, number, number, number | null | undefined];
      if (Buffer.isBuffer(buffer) && typeof offset === "number" && typeof length === "number") {
        writes++;
        return Reflect.apply(originalWriteSync, fsDefault, [
          fd,
          buffer,
          offset,
          Math.min(length, 5),
          position ?? null,
        ]) as number;
      }
      return Reflect.apply(originalWriteSync, fsDefault, args) as number;
    }) as typeof originalWriteSync;
    syncBuiltinESMExports();

    try {
      const out = new JsonlAppender<{ text: string }>(file);
      out.append({ text: "abcdefghijk" }, { fsync: false });
      out.close();
    } finally {
      fsDefault.writeSync = originalWriteSync;
      syncBuiltinESMExports();
    }

    expect(writes).toBeGreaterThan(1);
    expect(readJsonl<{ text: string }>(file)).toEqual([{ text: "abcdefghijk" }]);
  });
});

describe("supervisor lock", () => {
  it("refuses a live owner and releases the advisory lock", async () => {
    const paths = emptyRun("r_live_lock");
    const owner = await acquireLock(paths);

    await expect(acquireLock(paths)).rejects.toThrow(/live supervisor/);
    await owner.release();
    const next = await acquireLock(paths);
    await next.release();
  });

  it("ignores a stale legacy file once no process holds its kernel lock", async () => {
    const paths = emptyRun("r_legacy_lock");
    fs.writeFileSync(paths.lock, "2147483647");

    const owner = await acquireLock(paths);
    await owner.release();
    expect(fs.readFileSync(paths.lock, "utf8")).toBe("2147483647");
  });

  it("does not mistake lock-file contents for ownership", async () => {
    const paths = emptyRun("r_replaced_lock");
    const oldOwner = await acquireLock(paths);
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: "replacement" }));

    oldOwner.beat();
    await expect(acquireLock(paths)).rejects.toThrow(/live supervisor/);
    await oldOwner.release();
    expect(JSON.parse(fs.readFileSync(paths.lock, "utf8"))).toEqual({ pid: process.pid, token: "replacement" });
  });

  it("reports unexpected loss of the native lock holder", async () => {
    const paths = emptyRun("r_lost_lock");
    const owner = await acquireLock(paths);
    process.kill(owner.holderPid, "SIGKILL");
    await expect(owner.lost).rejects.toThrow(/lock holder exited unexpectedly/);
    await owner.release();

    const next = await acquireLock(paths);
    await next.release();
  });

  it("allows only one simultaneous process to acquire the lock", async () => {
    const runId = "r_atomic_lock";
    emptyRun(runId);
    const helper = path.join(__dirname, "helpers", "lock-contender.ts");
    const start = path.join(home, "start");
    const stop = path.join(home, "stop");
    const ready = [path.join(home, "ready-1"), path.join(home, "ready-2")];
    const results = [path.join(home, "result-1"), path.join(home, "result-2")];
    const children = ready.map((readyFile, index) =>
      spawn(
        process.execPath,
        ["--import", "tsx", helper, home, runId, readyFile, start, stop, results[index]],
        { cwd: path.join(__dirname, "..", "..", ".."), stdio: "ignore" },
      ),
    );
    const exits = children.map(childExit);

    await waitForFiles(ready);
    try {
      fs.writeFileSync(start, "");
      await waitForFiles(results);
      const outcomes = results.map((file) => fs.readFileSync(file, "utf8"));
      expect(outcomes.filter((outcome) => outcome === "acquired")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.startsWith("rejected:"))).toHaveLength(1);
    } finally {
      fs.writeFileSync(stop, "");
      await Promise.all(exits);
    }
  });
});

describe("hard-cancel trail files", () => {
  it("records the supervisor pid and overwrites it on reacquisition", () => {
    const paths = emptyRun("r_pid_trail");
    expect(readSupervisorPid(paths)).toBeUndefined();
    writeSupervisorPid(paths, 1234);
    expect(readSupervisorPid(paths)).toBe(1234);
    writeSupervisorPid(paths, 5678); // a resume takes over the trail
    expect(readSupervisorPid(paths)).toBe(5678);

    fs.writeFileSync(paths.supervisorPid, "not a pid");
    expect(readSupervisorPid(paths)).toBeUndefined();
  });

  it("livePgids is spawn minus exit", () => {
    const paths = emptyRun("r_pgid_trail");
    expect(livePgids(paths)).toEqual([]);
    appendPgid(paths, { t: "spawn", pgid: 100, atMs: 1 });
    appendPgid(paths, { t: "spawn", pgid: 200, atMs: 2 });
    expect(livePgids(paths)).toEqual([100, 200]);
    appendPgid(paths, { t: "exit", pgid: 100, atMs: 3 });
    expect(livePgids(paths)).toEqual([200]);
    appendPgid(paths, { t: "exit", pgid: 200, atMs: 4 });
    expect(livePgids(paths)).toEqual([]);
  });
});

describe("JsonlTail", () => {
  it("returns every record while parsing only appended bytes, across torn lines and split characters", () => {
    const file = path.join(home, "tail.jsonl");
    const tail = new JsonlTail<{ s: string }>(file);
    expect(tail.read()).toEqual([]); // no file yet
    fs.writeFileSync(file, '{"s":"one"}\n{"s":"tw');
    expect(tail.read()).toEqual([{ s: "one" }]);
    // Finish the torn record in two appends that split the two-byte "é".
    const rest = Buffer.from('o é"}\n');
    fs.appendFileSync(file, rest.subarray(0, 3));
    expect(tail.read()).toEqual([{ s: "one" }]);
    fs.appendFileSync(file, rest.subarray(3));
    expect(tail.read()).toEqual([{ s: "one" }, { s: "two é" }]);
    expect(tail.read()).toEqual([{ s: "one" }, { s: "two é" }]); // nothing new: no re-parse, same answer
  });

  it("re-reads from the start when the file changed behind it", () => {
    const file = path.join(home, "tail.jsonl");
    fs.writeFileSync(file, '{"n":1}\n{"n":2');
    const tail = new JsonlTail<{ n: number }>(file);
    expect(tail.read()).toEqual([{ n: 1 }]);
    // The appender's crash recovery drops the torn tail before appending; the
    // file is now longer than before, but our cached fragment is stale.
    const out = new JsonlAppender<{ n: number }>(file);
    out.append({ n: 3 }, { fsync: false });
    out.close();
    expect(tail.read()).toEqual([{ n: 1 }, { n: 3 }]);
    // A rewrite that shrinks the file.
    fs.writeFileSync(file, '{"n":9}\n');
    expect(tail.read()).toEqual([{ n: 9 }]);
    // Deletion.
    fs.rmSync(file);
    expect(tail.read()).toEqual([]);
  });

  it("reports committed corruption with the right line number", () => {
    const file = path.join(home, "tail.jsonl");
    fs.writeFileSync(file, '{"n":1}\n');
    const tail = new JsonlTail<{ n: number }>(file);
    tail.read();
    fs.appendFileSync(file, '{"n":2}\nnot-json\n');
    expect(() => tail.read()).toThrow(/line 3/);
  });
});
