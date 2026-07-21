import type {
  ApprovalRequest,
  JournalRecord,
  LeafStatus,
  LeafTraceRecord,
  RunManifest,
  RunState,
  RunStatus,
  TraceRecord,
} from "./contracts.js";
import { readJournal, readManifest, readTraces } from "./rundir.js";

/**
 * Pure projection: journal (deterministic status) + trace sidecar (detail,
 * running/failed leaves) -> RunStatus. Journal status wins where present.
 */
export function projectStatus(
  manifest: RunManifest,
  journal: JournalRecord[],
  traces: TraceRecord[],
): RunStatus {
  const leaves = new Map<number, LeafStatus>();
  const rearmed = new Set<number>();

  for (const rec of journal) {
    if (rec.t === "call") {
      leaves.set(rec.seq, {
        seq: rec.seq,
        id: rec.id,
        phase: rec.phase,
        kind: rec.kind,
        readOnly: rec.readOnly,
        status: "pending",
      });
    } else if (rec.t === "done") {
      const leaf = leaves.get(rec.seq);
      if (leaf) {
        rearmed.delete(rec.seq);
        leaf.status = rec.status;
        leaf.error = rec.error;
        leaf.resultSha = rec.resultSha;
        leaf.attempt = rec.attempt;
      }
    } else if (rec.t === "attempt") {
      const leaf = leaves.get(rec.seq);
      if (leaf) {
        rearmed.delete(rec.seq);
        leaf.status = "pending";
        leaf.error = undefined;
        leaf.resultSha = undefined;
        leaf.endMs = undefined;
        leaf.attempt = rec.attempt;
      }
    } else if (rec.t === "retry") {
      for (const seq of rec.seqs) {
        const leaf = leaves.get(seq);
        if (!leaf) continue;
        rearmed.add(seq);
        leaf.status = "pending";
        leaf.error = undefined;
        leaf.resultSha = undefined;
        leaf.endMs = undefined;
      }
    }
  }

  // Overlay sidecar detail; sidecar supplies "running" and timing/harness info.
  const bestTrace = latestLeafTraces(traces);
  for (const [seq, tr] of bestTrace) {
    const leaf = leaves.get(seq);
    if (!leaf || rearmed.has(seq)) continue;
    const currentAttempt = leaf.attempt ?? 0;
    if (tr.attempt < currentAttempt) continue;
    leaf.harness = tr.harness;
    leaf.startMs = tr.startMs;
    leaf.endMs = tr.endMs;
    if (tr.status === "running" && (tr.attempt > currentAttempt || leaf.status === "pending")) {
      leaf.status = "running";
      leaf.attempt = tr.attempt;
      leaf.error = undefined;
      leaf.resultSha = undefined;
    }
    if (leaf.status === "pending" && (tr.status === "ok" || tr.status === "error")) {
      // journal completion lost/behind; sidecar close is still informative
      leaf.status = tr.status;
      leaf.error = tr.error;
      leaf.attempt = tr.attempt;
    }
  }

  // Last finish wins; a retry record after it means a resume re-armed the run.
  let finish: Extract<JournalRecord, { t: "finish" }> | undefined;
  let finishIdx = -1;
  journal.forEach((r, i) => {
    if (r.t === "finish") {
      finish = r;
      finishIdx = i;
    }
  });
  const retriedAfterFinish = journal.some((r, i) => r.t === "retry" && i > finishIdx);
  const state: RunState =
    !finish || retriedAfterFinish ? "running" : finish.status === "completed" ? "completed" : finish.status;

  const all = [...leaves.values()].sort((a, b) => a.seq - b.seq);
  const settled = state !== "running";
  if (settled) {
    for (const leaf of all) {
      if (leaf.status === "running") {
        leaf.status = "pending";
        leaf.endMs = undefined;
      }
    }
  }
  const pendingApprovals = settled ? [] : openApprovals(traces);
  const endMs = settled ? Math.max(...all.map((l) => l.endMs ?? 0), manifest.createdAtMs) : undefined;

  return {
    runId: manifest.runId,
    state,
    totalCalls: all.length,
    ok: all.filter((l) => l.status === "ok").length,
    failed: all.filter((l) => l.status === "error").length,
    running: all.filter((l) => l.status === "running").length,
    approvalsPending: pendingApprovals.length,
    leaves: all,
    resultSha: settled ? finish?.resultSha : undefined,
    error: settled ? finish?.error : undefined,
    startedAtMs: manifest.createdAtMs,
    endedAtMs: endMs,
    approvalMode: manifest.approvalMode,
    allowWrites: manifest.allowWrites,
  };
}

/** Supersession: highest attempt wins; within an attempt, highest rev wins. */
export function latestLeafTraces(traces: TraceRecord[]): Map<number, LeafTraceRecord> {
  const best = new Map<number, LeafTraceRecord>();
  for (const rec of traces) {
    if (rec.t !== "leaf") continue;
    const cur = best.get(rec.seq);
    if (!cur || rec.attempt > cur.attempt || (rec.attempt === cur.attempt && rec.rev > cur.rev)) {
      best.set(rec.seq, rec);
    }
  }
  return best;
}

export function openApprovals(traces: TraceRecord[]): ApprovalRequest[] {
  const open = new Map<string, ApprovalRequest>();
  for (const rec of traces) {
    if (rec.t !== "event") continue;
    if (rec.event.kind === "approval-requested") open.set(rec.event.approval.id, rec.event.approval);
    if (rec.event.kind === "approval-resolved") open.delete(rec.event.approvalId);
  }
  return [...open.values()];
}

export function statusForRun(runId: string): RunStatus {
  return projectStatus(readManifest(runId), readJournal(runId), readTraces(runId));
}
