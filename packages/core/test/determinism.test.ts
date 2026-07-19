import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun, type Registry } from "../src/supervisor.js";
import { readJournal, readResult, runPaths } from "../src/rundir.js";
import { DivergenceError, type JournalRecord } from "../src/contracts.js";
import { makeFakeHarness, makeRegistry, mulberry32 } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-test-"));
  process.env.ORC_HOME = home;
});

function launchOpts(program: string, extra: Record<string, unknown> = {}) {
  return {
    programPath: FIX(program),
    cwd: home,
    brief: "test brief",
    ...extra,
  } as Parameters<typeof prepareRun>[0];
}

async function runProgram(program: string, registry: Registry, extra: Record<string, unknown> = {}) {
  const manifest = await prepareRun(launchOpts(program, extra), registry);
  const status = await superviseRun(manifest.runId, registry);
  return { manifest, status };
}

describe("live execution", () => {
  it("runs concurrent lanes with completion-time edges to completion", async () => {
    const rng = mulberry32(42);
    const registry = makeRegistry(makeFakeHarness({ latency: () => Math.floor(rng() * 30) }));
    const { manifest, status } = await runProgram("lanes.orc.ts", registry);
    expect(status.state).toBe("completed");
    expect(status.failed).toBe(0);
    expect(status.totalCalls).toBeGreaterThanOrEqual(8);
    const result = readResult(runPaths(manifest.runId), status.resultSha!);
    expect((result as Record<string, unknown>).done).toBe(true);
    // journal shape: every call has exactly one completion, then a finish
    const journal = readJournal(manifest.runId);
    const calls = journal.filter((r) => r.t === "call");
    const dones = journal.filter((r) => r.t === "done");
    expect(dones.length).toBe(calls.length);
    expect(journal.at(-1)?.t).toBe("finish");
  });

  it("phase() labels calls made inside the scope", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { manifest } = await runProgram("lanes.orc.ts", registry);
    const journal = readJournal(manifest.runId);
    const wrapCalls = journal.filter((r) => r.t === "call" && r.phase === "wrapup");
    expect(wrapCalls.length).toBe(2);
  });

  it("settle() collects a failed lane; parallel() runs siblings independently", async () => {
    // bad-lane is seq 1; the parallel group is seqs 2,3,4 and its middle member
    // (seq 3) fails FAST (0ms) while its siblings take 40ms. Under the old
    // sibling-abort behavior that fast failure would have cancelled seqs 2 & 4;
    // now every lane completes and parallel() returns a per-lane outcome.
    const registry = makeRegistry(
      makeFakeHarness({ failSeqs: [1, 3], latency: (seq) => (seq === 3 ? 0 : 40) }),
    );
    const { manifest, status } = await runProgram("settle-lanes.orc.ts", registry);
    expect(status.state).toBe("completed");
    const result = readResult(runPaths(manifest.runId), status.resultSha!) as {
      lanes: Array<{ status: string }>;
      grouped: Array<{ status: string }>;
    };
    expect(result.lanes[0].status).toBe("ok");
    expect(result.lanes[1].status).toBe("error");
    // The failing group member does NOT cancel its siblings.
    expect(result.grouped.map((g) => g.status)).toEqual(["ok", "error", "ok"]);
  });

  it("ext.* leaves execute host-side and are journaled", async () => {
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "lookup",
          {
            name: "lookup",
            readOnly: true,
            execute: async (payload) => ({ found: true, payload }),
          },
        ],
      ]),
    });
    const { manifest, status } = await runProgram("ext.orc.ts", registry);
    expect(status.state).toBe("completed");
    const journal = readJournal(manifest.runId);
    const extCall = journal.find((r) => r.t === "call" && r.kind === "ext:lookup");
    expect(extCall).toBeDefined();
    const result = readResult(runPaths(manifest.runId), status.resultSha!) as Record<string, unknown>;
    expect((result.fetched as Record<string, unknown>).found).toBe(true);
  });
});

describe("policy and sandbox", () => {
  it("fail-closed: write leaf without allow_writes never dispatches", async () => {
    const log = path.join(home, "invocations.log");
    const registry = makeRegistry(makeFakeHarness({ invocationLog: log }));
    const { status } = await runProgram("writegate.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/allow_writes/);
    expect(fs.existsSync(log)).toBe(false); // no leaf ever invoked
  });

  it("write leaf runs when allow_writes granted", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { status } = await runProgram("writegate.orc.ts", registry, { allowWrites: true });
    expect(status.state).toBe("completed");
  });

  it("deadlocked program fails with a defined outcome", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { status } = await runProgram("deadlock.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/deadlock/);
  });

  it("ambient authority is stripped: Date.now() throws in-program", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { status } = await runProgram("ambient.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/Date\.now is not available in orc programs/);
  });

  it("step budget terminates a spinning program as a failed run", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { status } = await runProgram("spin.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/step budget/);
  });
});

describe("replay identity", () => {
  it("resume of a completed run refuses; crash-mid-run replay reproduces the result", async () => {
    // Live run with fuzzed latencies.
    const rng = mulberry32(7);
    const registry = makeRegistry(makeFakeHarness({ latency: () => Math.floor(rng() * 25) }));
    const { manifest, status } = await runProgram("lanes.orc.ts", registry);
    expect(status.state).toBe("completed");

    // Simulate crash-before-finish: strip the finish record, keep everything else.
    const paths = runPaths(manifest.runId);
    const records = readJournal(manifest.runId).filter((r) => r.t !== "finish");
    fs.writeFileSync(paths.journal, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // Resume with a harness that would FAIL if any leaf re-dispatched:
    // every completion must come from the journal.
    const poisoned = makeRegistry(
      makeFakeHarness({
        result: () => {
          throw new Error("leaf re-dispatched during pure replay");
        },
      }),
    );
    const resumed = await superviseRun(manifest.runId, poisoned);
    expect(resumed.state).toBe("completed");
    expect(resumed.resultSha).toBe(status.resultSha); // byte-identical final result
  });

  it("fuzz: replay reproduces the live result across randomized completion orders", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const rng = mulberry32(seed);
      const registry = makeRegistry(makeFakeHarness({ latency: () => Math.floor(rng() * 20) }));
      const { manifest, status } = await runProgram("lanes.orc.ts", registry);
      expect(status.state).toBe("completed");
      const paths = runPaths(manifest.runId);
      const records = readJournal(manifest.runId).filter((r) => r.t !== "finish");
      fs.writeFileSync(paths.journal, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const poisoned = makeRegistry(
        makeFakeHarness({
          result: () => {
            throw new Error(`seed ${seed}: leaf re-dispatched during pure replay`);
          },
        }),
      );
      const resumed = await superviseRun(manifest.runId, poisoned);
      expect(resumed.resultSha, `seed ${seed}`).toBe(status.resultSha);
    }
  });
});

describe("divergence detection (bidirectional)", () => {
  async function crashedRun() {
    const registry = makeRegistry(makeFakeHarness());
    const { manifest } = await runProgram("lanes.orc.ts", registry);
    const paths = runPaths(manifest.runId);
    const records = readJournal(manifest.runId).filter((r) => r.t !== "finish");
    return { manifest, paths, records, registry };
  }
  function writeJournal(paths: ReturnType<typeof runPaths>, records: JournalRecord[]) {
    fs.writeFileSync(paths.journal, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  it("changed call digest → loud divergence", async () => {
    const { manifest, paths, records, registry } = await crashedRun();
    const idx = records.findIndex((r) => r.t === "call");
    (records[idx] as Extract<JournalRecord, { t: "call" }>).specDigest = "0".repeat(64);
    writeJournal(paths, records);
    await expect(superviseRun(manifest.runId, registry)).rejects.toThrow(DivergenceError);
  });

  it("dangling completion (done for a call never made) → loud divergence", async () => {
    const { manifest, paths, records, registry } = await crashedRun();
    records.push({ t: "done", seq: 9999, status: "ok", resultSha: "0".repeat(64), sizeBytes: 2, attempt: 1 });
    writeJournal(paths, records);
    await expect(superviseRun(manifest.runId, registry)).rejects.toThrow(/dangling|never requested/);
  });

  it("tampered program bundle → refuses before executing anything", async () => {
    const { manifest, paths, records, registry } = await crashedRun();
    writeJournal(paths, records);
    fs.appendFileSync(paths.program, "\n// tampered\n");
    await expect(superviseRun(manifest.runId, registry)).rejects.toThrow(/does not match manifest hash/);
  });

  it("torn journal tail is truncated safely, not misparsed", async () => {
    const { manifest, paths, records, registry } = await crashedRun();
    writeJournal(paths, records);
    fs.appendFileSync(paths.journal, '{"t":"done","seq":3,"status":"o'); // torn write
    const poisonFree = makeRegistry(makeFakeHarness());
    const resumed = await superviseRun(manifest.runId, poisonFree);
    expect(resumed.state).toBe("completed");
    void registry;
  });
});

describe("fail-forward resume", () => {
  it("a failed write leaf resumes with a re-orienting attempt (never blind)", async () => {
    const log = path.join(home, "invocations.log");
    // First run: the write leaf (seq 1) fails.
    const failing = makeRegistry(makeFakeHarness({ failSeqs: [1], invocationLog: log }));
    const { manifest, status } = await runProgram("write-once.orc.ts", failing, { allowWrites: true });
    expect(status.state).toBe("failed");

    // Resume: seq 1 re-dispatches, seq 0 must NOT re-dispatch (journal replay).
    const healthy = makeRegistry(makeFakeHarness({ invocationLog: log }));
    const resumed = await superviseRun(manifest.runId, healthy);
    expect(resumed.state).toBe("completed");

    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    const seq0Count = lines.filter((l) => l.startsWith("0:")).length;
    const seq1Count = lines.filter((l) => l.startsWith("1:")).length;
    expect(seq0Count).toBe(1); // read leaf ran exactly once across both runs
    expect(seq1Count).toBe(2); // write leaf: original + re-orient attempt
    const retryLine = lines.find((l) => l.startsWith("1:") && l.includes("RE-ORIENT NOTE"));
    expect(retryLine, "resumed write attempt carries the re-orient preamble").toBeDefined();

    // Journal is append-only history: retry marker present, attempt=2 recorded.
    const journal = readJournal(manifest.runId);
    expect(journal.some((r) => r.t === "retry")).toBe(true);
    const doneRecords = journal.filter((r) => r.t === "done" && r.seq === 1);
    expect(doneRecords.at(-1)?.attempt).toBe(2);
  });

  it("resume of a completed run refuses", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const { manifest } = await runProgram("lanes.orc.ts", registry);
    await expect(superviseRun(manifest.runId, registry)).rejects.toThrow(/already completed/);
  });
});
