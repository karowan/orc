/**
 * Leaf trace records carry tool-call deltas, not the cumulative list. Writing
 * the whole list on every revision made traces.jsonl grow quadratically with
 * tool use (a 160-call leaf wrote its history 160 times over, 661MB for one
 * run) — past V8's string cap nothing could read it. latestLeafTraces() folds
 * the deltas back, and folds the old cumulative shape to the same answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LeafTraceRecord, ToolCallTrace } from "../src/contracts.js";
import { readJournal, readTraces } from "../src/rundir.js";
import { latestLeafTraces, makeTraceCompactor, statusForRun } from "../src/status.js";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { makeFakeHarness, makeRegistry } from "./helpers/fake.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-trace-deltas-"));
  process.env.ORC_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("tool-call deltas in leaf traces", () => {
  it("writes each tool-call change once instead of the cumulative list on every revision", async () => {
    const program = path.join(home, "one.orc.ts");
    fs.writeFileSync(program, `export default async ({ agent }: any) => agent("go");\n`);
    const calls = 25;
    const registry = makeRegistry(makeFakeHarness({ toolCallsPerLeaf: calls }));
    const manifest = await prepareRun({ programPath: program, cwd: home }, registry);
    expect((await superviseRun(manifest.runId, registry)).state).toBe("completed");

    const traces = readTraces(manifest.runId);
    const leafRecords = traces.filter((r): r is LeafTraceRecord => r.t === "leaf");
    const written = leafRecords.reduce((n, r) => n + (r.toolCalls?.length ?? 0), 0);
    // One entry per open and one per close. The cumulative shape wrote ~calls² entries.
    expect(written).toBeLessThanOrEqual(2 * calls);
    expect(Math.max(...leafRecords.map((r) => r.toolCalls?.length ?? 0))).toBeLessThan(calls);

    // Readers still see the whole list, in call order, with final statuses.
    const [folded] = [...latestLeafTraces(traces).values()];
    expect(folded.toolCalls).toHaveLength(calls);
    expect(folded.toolCalls!.map((tc) => Number(tc.id.split("-")[1]))).toEqual([...Array(calls).keys()]);
    expect(folded.toolCalls!.every((tc) => tc.status === "ok" && tc.endMs !== undefined)).toBe(true);

    // The status projection folds the same way whether it reads disk or is handed the records.
    const fromDisk = statusForRun(manifest.runId);
    const preloaded = statusForRun(manifest.runId, { traces, journal: readJournal(manifest.runId) });
    expect(preloaded).toEqual(fromDisk);
    expect(JSON.stringify(fromDisk)).toContain(`"toolCallCount":${calls}`);
  });

  it("folds the cumulative and delta shapes identically, starting fresh per attempt, without mutating inputs", () => {
    const mk = (attempt: number, rev: number, toolCalls: ToolCallTrace[]): LeafTraceRecord => ({
      t: "leaf", seq: 1, attempt, rev, status: "running", kind: "agent", readOnly: true, startMs: 0, toolCalls,
    });
    const a: ToolCallTrace = { id: "a", name: "T", status: "running" };
    const aDone: ToolCallTrace = { ...a, status: "ok", endMs: 5 };
    const b: ToolCallTrace = { id: "b", name: "T", status: "running" };
    const ids = (records: LeafTraceRecord[]) =>
      latestLeafTraces(records).get(1)!.toolCalls!.map((tc) => `${tc.id}:${tc.status}`);

    const cumulative = [mk(1, 0, [a]), mk(1, 1, [aDone]), mk(1, 2, [aDone, b])];
    const delta = [mk(1, 0, [a]), mk(1, 1, [aDone]), mk(1, 2, [b])];
    expect(ids(delta)).toEqual(["a:ok", "b:running"]);
    expect(ids(cumulative)).toEqual(ids(delta));

    // A retry is a new attempt: the previous attempt's calls do not leak in.
    const c: ToolCallTrace = { id: "c", name: "T", status: "running" };
    expect(ids([...delta, mk(2, 0, [c])])).toEqual(["c:running"]);

    // Folding copies; the records (which a monitor caches) keep their deltas.
    expect(delta[2].toolCalls).toEqual([b]);
    expect(latestLeafTraces([mk(1, 0, [])]).get(1)!.toolCalls).toEqual([]);
  });
});

describe("makeTraceCompactor", () => {
  it("shares closed tool calls across revisions and leaves running ones alone, without changing the fold", () => {
    const compact = makeTraceCompactor();
    const mk = (attempt: number, rev: number, toolCalls: ToolCallTrace[]): LeafTraceRecord => ({
      t: "leaf", seq: 3, attempt, rev, status: "running", kind: "agent", readOnly: true, startMs: 0, toolCalls,
    });
    const done = (id: string): ToolCallTrace => ({ id, name: "T", status: "ok", endMs: 1, result: { big: "x".repeat(64) } });
    // The legacy cumulative shape: every revision repeats every earlier call.
    const r0 = compact(mk(1, 0, [{ id: "a", name: "T", status: "running" }])) as LeafTraceRecord;
    const r1 = compact(mk(1, 1, [done("a"), { id: "b", name: "T", status: "running" }])) as LeafTraceRecord;
    const r2 = compact(mk(1, 2, [done("a"), done("b")])) as LeafTraceRecord;
    const r3 = compact(mk(1, 3, [done("a"), done("b"), done("c")])) as LeafTraceRecord;
    expect(r0.toolCalls![0].status).toBe("running");
    expect(r2.toolCalls![0]).toBe(r1.toolCalls![0]); // "a" closed in r1: later copies share that object
    expect(r3.toolCalls![1]).toBe(r2.toolCalls![1]); // "b" closed in r2
    expect(r3.toolCalls![2]).not.toBe(r2.toolCalls![1]);
    expect(r1.toolCalls![0]).not.toBe(r0.toolCalls![0]); // a running call is never treated as final
    const folded = latestLeafTraces([r0, r1, r2, r3]).get(3)!.toolCalls!;
    expect(folded.map((tc) => `${tc.id}:${tc.status}`)).toEqual(["a:ok", "b:ok", "c:ok"]);
    // A new attempt starts a fresh table.
    const r4 = compact(mk(2, 0, [done("a")])) as LeafTraceRecord;
    expect(r4.toolCalls![0]).not.toBe(r1.toolCalls![0]);
  });
});
