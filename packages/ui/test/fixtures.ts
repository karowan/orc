import * as fs from "node:fs";
import * as path from "node:path";
import type { JournalRecord, RunManifest, TraceRecord } from "@orc/core/src/contracts.js";

export const T0 = 1_700_000_000_000;

export const XSS_PROMPT = "Review this <script>alert(1)</script> carefully";

export function makeManifest(runId: string, over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId,
    name: "demo run",
    programPath: "/tmp/program.ts",
    programSha256: "deadbeefdeadbeef",
    cwd: "/tmp/work",
    host: "build@ci-box",
    brief: "do the thing",
    allowWrites: true,
    approvalMode: "manual",
    maxParallel: 4,
    idleTimeoutMs: false,
    defaultHarness: "claude",
    createdAtMs: T0,
    orcVersion: "0.1.0",
    ...over,
  };
}

/** Three calls: #1 ok, #2 running (no completion), #3 failed. */
export function makeJournal(): JournalRecord[] {
  return [
    { t: "call", seq: 1, kind: "agent", id: "plan", phase: "plan", readOnly: true, specDigest: "d1" },
    { t: "done", seq: 1, status: "ok", resultSha: "sha1", sizeBytes: 42, attempt: 1 },
    { t: "call", seq: 2, kind: "agent", id: "build", phase: "build", readOnly: false, specDigest: "d2" },
    { t: "call", seq: 3, kind: "agent", phase: "build", readOnly: true, specDigest: "d3" },
    { t: "done", seq: 3, status: "error", error: "leaf exploded", attempt: 1 },
  ];
}

export function makeTraces(runId: string): TraceRecord[] {
  return [
    { t: "event", atMs: T0, event: { kind: "log", message: "supervisor started" } },
    { t: "event", atMs: T0 + 500, event: { kind: "phase", name: "plan" } },
    {
      t: "leaf", seq: 1, attempt: 1, rev: 0, status: "running", id: "plan", phase: "plan",
      kind: "agent", harness: "claude", model: "opus", readOnly: true, startMs: T0 + 1_000,
      prompt: XSS_PROMPT,
    },
    {
      t: "leaf", seq: 1, attempt: 1, rev: 1, status: "ok", id: "plan", phase: "plan",
      kind: "agent", harness: "claude", model: "claude-fable-5", reasoningEffort: "high", readOnly: true,
      startMs: T0 + 1_000, endMs: T0 + 11_000,
      prompt: XSS_PROMPT,
      output: { summary: "planned", steps: 3 },
      toolCalls: [
        { id: "t1", name: "Read", input: { file_path: "/src/app.ts" }, result: "line 1\nline 2", status: "ok", startMs: T0 + 2_000, endMs: T0 + 2_400 },
        { id: "t2", name: "Grep", input: { pattern: "TODO" }, result: "no matches", status: "error", startMs: T0 + 3_000, endMs: T0 + 3_100 },
      ],
      tokensIn: 1200, tokensOut: 340, costUsd: 0.1234, costEstimated: false,
    },
    {
      t: "leaf", seq: 2, attempt: 1, rev: 0, status: "running", id: "build", phase: "build",
      kind: "agent", harness: "claude", host: "build@ci-box", readOnly: false, startMs: T0 + 12_000,
      prompt: "build it",
    },
    {
      t: "leaf", seq: 3, attempt: 1, rev: 1, status: "error", phase: "build",
      kind: "agent", harness: "codex", readOnly: true,
      startMs: T0 + 12_500, endMs: T0 + 14_000,
      prompt: "verify it", error: "leaf exploded",
      tokensIn: 5000, tokensOut: 120, costUsd: 0.0075, costEstimated: true,
    },
    {
      t: "event", atMs: T0 + 13_000,
      event: {
        kind: "approval-requested",
        approval: {
          id: "appr_1", runId, seq: 2, toolName: "Bash",
          input: { command: "rm -rf ./dist" }, requestedAtMs: T0 + 13_000,
        },
      },
    },
    // Harness stderr (per-leaf hlog channel): repeats dedupe in the drawer.
    { t: "hlog", seq: 1, atMs: T0 + 2_100, message: "ERROR failed to renew cache TTL: missing field `supports_reasoning_summaries`" },
    { t: "hlog", seq: 1, atMs: T0 + 4_100, message: "ERROR failed to renew cache TTL: missing field `supports_reasoning_summaries`" },
    { t: "hlog", seq: 1, atMs: T0 + 4_200, message: "INFO thread started" },
  ];
}

export interface FixtureRun {
  runId: string;
  dir: string;
  manifest: RunManifest;
  journal: JournalRecord[];
  traces: TraceRecord[];
  journalPath: string;
  tracesPath: string;
  controlPath: string;
}

/**
 * Fabricate a run directory under $ORC_HOME/runs/<runId> directly from the
 * record shapes (manifest.json + journal.jsonl + traces.jsonl).
 */
export function writeRunDir(
  runId: string,
  opts: { settled?: boolean; manifest?: Partial<RunManifest> } = {},
): FixtureRun {
  const home = process.env.ORC_HOME;
  if (!home) throw new Error("fixture requires ORC_HOME to be set");
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = makeManifest(runId, opts.manifest);
  const journal = makeJournal();
  const traces = makeTraces(runId);
  if (opts.settled) {
    journal.push({ t: "done", seq: 2, status: "ok", resultSha: "sha2", attempt: 1 });
    journal.push({ t: "finish", status: "completed", resultSha: "shafinal" });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), journal.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "traces.jsonl"), traces.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return {
    runId,
    dir,
    manifest,
    journal,
    traces,
    journalPath: path.join(dir, "journal.jsonl"),
    tracesPath: path.join(dir, "traces.jsonl"),
    controlPath: path.join(dir, "control.jsonl"),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}
