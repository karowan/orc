import { describe, expect, it } from "vitest";
import type { JournalRecord, RunManifest, TraceRecord } from "../src/contracts.js";
import { projectStatus } from "../src/status.js";

const manifest: RunManifest = {
  runId: "r_test",
  programPath: "/tmp/p.orc.ts",
  programSha256: "0".repeat(64),
  cwd: "/tmp",
  brief: "test",
  allowWrites: false,
  approvalMode: "auto",
  sandbox: false,
  sandboxDirs: [],
  networkAccess: false,
  maxParallel: 1,
  idleTimeoutMs: false,
  defaultHarness: "fake",
  createdAtMs: 1,
  orcVersion: "test",
};

describe("status projection across retries", () => {
  it("shows the new running attempt without stale terminal fields", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "finish", status: "failed", error: "old failure" },
      { t: "retry", seqs: [0], atMs: 3 },
      { t: "attempt", seq: 0, attempt: 2, atMs: 4 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 2,
        rev: 0,
        status: "running",
        kind: "agent",
        readOnly: true,
        startMs: 4,
      },
    ];

    const status = projectStatus(manifest, journal, traces);
    expect(status.state).toBe("running");
    expect(status.error).toBeUndefined();
    expect(status.resultSha).toBeUndefined();
    expect(status.leaves[0]).toMatchObject({ status: "running", attempt: 2 });
    expect(status.leaves[0].error).toBeUndefined();
  });

  it("does not overlay an old attempt's timing after a new attempt starts", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "attempt", seq: 0, attempt: 2, atMs: 4 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        kind: "agent",
        readOnly: true,
        startMs: 2,
        endMs: 3,
        error: "old failure",
      },
    ];

    const leaf = projectStatus(manifest, journal, traces).leaves[0];
    expect(leaf).toMatchObject({ status: "pending", attempt: 2 });
    expect(leaf.error).toBeUndefined();
    expect(leaf.startMs).toBeUndefined();
    expect(leaf.endMs).toBeUndefined();
  });

  it("keeps a re-armed leaf pending before its next attempt starts", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "attempt", seq: 0, attempt: 1, atMs: 2 },
      { t: "done", seq: 0, attempt: 1, status: "error", error: "old failure" },
      { t: "finish", status: "failed", error: "old failure" },
      { t: "retry", seqs: [0], atMs: 3 },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 1,
        status: "error",
        kind: "agent",
        readOnly: true,
        startMs: 2,
        endMs: 3,
        error: "old failure",
      },
    ];

    const status = projectStatus(manifest, journal, traces);
    expect(status.state).toBe("running");
    expect(status.leaves[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect(status.leaves[0].error).toBeUndefined();
    expect(status.leaves[0].endMs).toBeUndefined();
  });

  it("does not let a same-attempt running trace override a durable completion", () => {
    const journal: JournalRecord[] = [
      { t: "call", seq: 0, kind: "agent", readOnly: true, specDigest: "a" },
      { t: "done", seq: 0, attempt: 1, status: "ok", resultSha: "result" },
    ];
    const traces: TraceRecord[] = [
      {
        t: "leaf",
        seq: 0,
        attempt: 1,
        rev: 0,
        status: "running",
        kind: "agent",
        readOnly: true,
        startMs: 2,
      },
    ];

    expect(projectStatus(manifest, journal, traces).leaves[0]).toMatchObject({
      status: "ok",
      attempt: 1,
      resultSha: "result",
    });
  });
});
