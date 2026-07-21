import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  readControl,
  runPaths,
  type JournalRecord,
  type Registry,
  type RunManifest,
  type TraceRecord,
} from "@karowanorg/orc-core";
import {
  cancel,
  respondApproval,
  resume,
  spawnDetachedSupervisor,
  type OpContext,
} from "@karowanorg/orc-ops";

const registry: Registry = {
  harnesses: new Map(),
  extensions: new Map(),
  defaultHarness: "none",
  executorFor() {
    throw new Error("not used");
  },
};
const ctx: OpContext = { registry };

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.ORC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-controls-"));
  process.env.ORC_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRun(
  runId: string,
  options: { completed?: boolean; approvalId?: string } = {},
): void {
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
    maxParallel: 1,
    idleTimeoutMs: false,
    defaultHarness: "none",
    createdAtMs: Date.now(),
    orcVersion: "0.1.0",
  };
  const journal: JournalRecord[] = options.completed
    ? [{ t: "finish", status: "completed", resultSha: "result" }]
    : [];
  const traces: TraceRecord[] = options.approvalId
    ? [{
        t: "event",
        atMs: Date.now(),
        event: {
          kind: "approval-requested",
          approval: {
            id: options.approvalId,
            runId,
            seq: 1,
            toolName: "Bash",
            input: { command: "echo ok" },
            requestedAtMs: Date.now(),
          },
        },
      }]
    : [];
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  fs.writeFileSync(paths.journal, journal.length ? journal.map((record) => JSON.stringify(record)).join("\n") + "\n" : "");
  fs.writeFileSync(paths.traces, traces.length ? traces.map((record) => JSON.stringify(record)).join("\n") + "\n" : "");
}

describe("control operations", () => {
  it("rejects unknown and stale controls before creating control.jsonl", async () => {
    await expect(cancel.handler({ runId: "missing" }, ctx)).rejects.toThrow();
    await expect(
      respondApproval.handler(
        { runId: "missing", approvalId: "a1", behavior: "allow" },
        ctx,
      ),
    ).rejects.toThrow();

    writeRun("completed", { completed: true });
    await expect(cancel.handler({ runId: "completed" }, ctx)).rejects.toThrow("not running");
    expect(fs.existsSync(runPaths("completed").control)).toBe(false);
  });

  it("only queues answers for approvals that are still open", async () => {
    writeRun("running", { approvalId: "pending" });
    await expect(
      respondApproval.handler(
        { runId: "running", approvalId: "stale", behavior: "deny" },
        ctx,
      ),
    ).rejects.toThrow("not pending");
    expect(fs.existsSync(runPaths("running").control)).toBe(false);

    await expect(
      respondApproval.handler(
        { runId: "running", approvalId: "pending", behavior: "allow" },
        ctx,
      ),
    ).resolves.toEqual({ enqueued: true });
    await expect(cancel.handler({ runId: "running" }, ctx)).resolves.toEqual({ enqueued: true });
    expect(readControl("running").map((message) => message.t)).toEqual(["approval", "cancel"]);
  });
});

describe("detached resume preflight", () => {
  it("reports child startup errors instead of returning a false success", async () => {
    await expect(spawnDetachedSupervisor("missing")).rejects.toThrow("manifest.json");
  }, 15_000);

  it("does not report resumed before supervisor preflight succeeds", async () => {
    writeRun("tampered");
    fs.writeFileSync(runPaths("tampered").program, "not the pinned bundle");
    await expect(resume.handler({ runId: "tampered", wait: false }, ctx)).rejects.toThrow(
      "program bundle does not match manifest hash",
    );
  }, 15_000);

  it("rejects completed runs before spawning", async () => {
    writeRun("done", { completed: true });
    await expect(resume.handler({ runId: "done", wait: false }, ctx)).rejects.toThrow("already completed");
  });

  it("rejects a run owned by a live supervisor", async () => {
    writeRun("owned");
    const lock = await acquireLock(runPaths("owned"));
    try {
      await expect(resume.handler({ runId: "owned", wait: false }, ctx)).rejects.toThrow("live supervisor");
    } finally {
      await lock.release();
    }
  });
});
