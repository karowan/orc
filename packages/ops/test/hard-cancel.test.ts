import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonlAppender,
  acquireLock,
  appendPgid,
  readControl,
  readJournal,
  runPaths,
  statusForRun,
  writeSupervisorPid,
  type JournalRecord,
  type Registry,
  type RunManifest,
} from "@karowanorg/orc-core";
import { cancel, status as statusOp, type OpContext } from "@karowanorg/orc-ops";

const registry: Registry = {
  harnesses: new Map(),
  extensions: new Map(),
  defaultHarness: "none",
  executor: new Proxy({} as never, {
    get() {
      throw new Error("not used");
    },
  }),
};
const ctx: OpContext = { registry };

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.ORC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-hard-cancel-"));
  process.env.ORC_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
}

function writeRun(runId: string, options: { completed?: boolean } = {}): void {
  const paths = runPaths(runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  const manifest: RunManifest = {
    runId,
    programPath: path.join(home, "program.orc.ts"),
    programSha256: "deadbeef",
    cwd: home,
    brief: "test",
    allowWrites: false,
    approvalMode: "auto",
    sandbox: false,
    sandboxDirs: [],
    networkAccess: false,
    maxParallel: 1,
    idleTimeoutMs: false,
    defaultHarness: "none",
    createdAtMs: Date.now(),
    orcVersion: "0.1.0",
  };
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  fs.writeFileSync(
    paths.journal,
    options.completed
      ? JSON.stringify({ t: "finish", status: "completed", resultSha: "result" }) + "\n"
      : "",
  );
  fs.writeFileSync(paths.traces, "");
}

describe("hard cancel", () => {
  it("kills recorded process groups of a dead-supervisor run and finishes the journal", async () => {
    writeRun("stalled");
    const paths = runPaths("stalled");
    // A TERM-ignoring leaf child, detached like LocalExecutor spawns them, its
    // pgid recorded the way the supervisor's leaf executor records it.
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    appendPgid(paths, { t: "spawn", pgid: child.pid!, atMs: Date.now() });
    // A supervisor that is already dead: only its recorded pid remains.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    writeSupervisorPid(paths, dead.pid!);

    const result = await cancel.handler(cancel.input.parse({ runId: "stalled", graceSeconds: 0.2 }), ctx);
    expect(result).toEqual({ enqueued: true, settled: true, hard: true });
    expect(await waitFor(() => !pidAlive(child.pid!), 2_000)).toBe(true);
    const finish = [...readJournal("stalled")].reverse().find((record) => record.t === "finish");
    expect(finish).toMatchObject({
      t: "finish",
      status: "cancelled",
      error: "cancelled by operator (hard)",
    });
    expect(statusForRun("stalled").state).toBe("cancelled");
  });

  it("force-kills a live but wedged supervisor once the grace expires", async () => {
    writeRun("wedged");
    const ready = path.join(home, "wedged-ready");
    const helper = path.join(__dirname, "helpers", "wedged-supervisor.ts");
    const child = spawn(process.execPath, ["--import", "tsx", helper, home, "wedged", ready], {
      detached: true,
      stdio: "ignore",
      cwd: path.join(__dirname, "..", "..", ".."),
    });
    child.unref();
    expect(await waitFor(() => fs.existsSync(ready), 20_000)).toBe(true);

    const result = await cancel.handler(cancel.input.parse({ runId: "wedged", graceSeconds: 0.3 }), ctx);
    expect(result).toEqual({ enqueued: true, settled: true, hard: true });
    expect(await waitFor(() => !pidAlive(child.pid!), 2_000)).toBe(true);
    expect(statusForRun("wedged").state).toBe("cancelled");
    // The lock is free again: the run is truly terminal, not just relabeled.
    const lock = await acquireLock(runPaths("wedged"));
    await lock.release();
  }, 30_000);

  it("returns cooperatively when a live supervisor settles within the grace", async () => {
    writeRun("coop");
    const lock = await acquireLock(runPaths("coop"));
    try {
      const pending = cancel.handler(cancel.input.parse({ runId: "coop", graceSeconds: 5 }), ctx);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Simulate the live supervisor consuming the control message and settling.
      const appender = new JsonlAppender<JournalRecord>(runPaths("coop").journal);
      appender.append({ t: "finish", status: "cancelled", error: "cancelled by operator", controlOffset: 1 });
      appender.close();
      const result = await pending;
      expect(result).toEqual({ enqueued: true, settled: true, hard: false });
      // The cooperative finish stands; the hard-path record was never written.
      expect(statusForRun("coop").error).toBe("cancelled by operator");
    } finally {
      await lock.release();
    }
  });

  it("hard: false only queues the control message", async () => {
    writeRun("soft");
    const result = await cancel.handler(cancel.input.parse({ runId: "soft", hard: false }), ctx);
    expect(result).toEqual({ enqueued: true });
    expect(readControl("soft").map((message) => message.t)).toEqual(["cancel"]);
    expect(readJournal("soft")).toEqual([]);
    expect(statusForRun("soft").state).toBe("running");
  });
});

describe("status supervisor-liveness probe", () => {
  it("reports supervisorAlive for unfinished runs and omits it for settled ones", async () => {
    writeRun("probe");
    const stalled = await statusOp.handler({ runId: "probe" }, ctx);
    expect(stalled).toMatchObject({ state: "running", supervisorAlive: false });

    const lock = await acquireLock(runPaths("probe"));
    try {
      const alive = await statusOp.handler({ runId: "probe" }, ctx);
      expect(alive).toMatchObject({ state: "running", supervisorAlive: true });
    } finally {
      await lock.release();
    }

    writeRun("finished", { completed: true });
    const settled = await statusOp.handler({ runId: "finished" }, ctx);
    expect(settled.state).toBe("completed");
    expect("supervisorAlive" in settled).toBe(false);
  });
});
