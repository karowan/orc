import type {
  ApprovalDecision,
  ApprovalRequest,
  JournalRecord,
  LeafStatus,
  LeafTraceRecord,
  RunApprovalDetail,
  RunArtifactDetail,
  RunAttemptDetail,
  RunCostBasis,
  RunDetail,
  RunGraph,
  RunLogDetail,
  RunManifest,
  RunStageDetail,
  RunStageMetrics,
  RunState,
  RunStatus,
  RunTextPreview,
  RunToolCallDetail,
  ToolCallTrace,
  TraceRecord,
  UiPresentation,
} from "./contracts.js";
import { boundString } from "./canonical.js";
import { programMetaFromTraces } from "./program-meta.js";
import { readJournal, readManifest, readTraces } from "./rundir.js";

const STATUS_ATTEMPTS_PER_STAGE = 24;
const STATUS_TOOL_CALLS_TOTAL = 256;
const STATUS_TOOL_CALLS_PER_ATTEMPT = 16;
const STATUS_ARTIFACTS_TOTAL = 64;
const STATUS_ARTIFACTS_PER_STAGE = 12;
const STATUS_LOGS_TOTAL = 256;
const STATUS_LOGS_PER_STAGE = 40;
const STATUS_APPROVALS_PER_STAGE = 24;
const STATUS_RUN_LOGS = 80;
const STATUS_PROMPT_BYTES = 2 * 1024;
const STATUS_OUTPUT_BYTES = 4 * 1024;
const STATUS_TOOL_INPUT_BYTES = 1024;
const STATUS_TOOL_RESULT_BYTES = 2 * 1024;
const STATUS_DOCUMENT_BYTES = 8 * 1024;
const STATUS_SUMMARY_BYTES = 1024;
const STATUS_LOG_BYTES = 1024;

export interface ApprovalResponse {
  behavior?: ApprovalDecision["behavior"];
  action?: string;
  message?: string;
}

/**
 * Resolve either a legacy allow/deny response or a named action. Named actions
 * derive their behavior from the request so callers cannot change semantics.
 */
export function resolveApprovalDecision(
  approval: ApprovalRequest,
  response: ApprovalResponse,
): ApprovalDecision {
  if (response.action !== undefined) {
    const action = approval.actions?.find(
      (candidate) => candidate.id === response.action,
    );
    if (!action)
      throw new Error(`approval action "${response.action}" is not available`);
    if (
      response.behavior !== undefined &&
      response.behavior !== action.behavior
    ) {
      throw new Error(
        `approval action "${action.id}" requires behavior "${action.behavior}"`,
      );
    }
    if (action.message?.required && !response.message?.trim()) {
      throw new Error(`approval action "${action.id}" requires a message`);
    }
    return {
      behavior: action.behavior,
      action: action.id,
      ...(response.message !== undefined ? { message: response.message } : {}),
    };
  }
  if (approval.actions?.length)
    throw new Error("a named approval action is required");
  if (response.behavior !== "allow" && response.behavior !== "deny") {
    throw new Error('behavior must be "allow" or "deny"');
  }
  return {
    behavior: response.behavior,
    ...(response.message !== undefined ? { message: response.message } : {}),
  };
}

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
        parallelGroup: rec.parallelGroup,
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
    if (
      tr.status === "running" &&
      (tr.attempt > currentAttempt || leaf.status === "pending")
    ) {
      leaf.status = "running";
      leaf.attempt = tr.attempt;
      leaf.error = undefined;
      leaf.resultSha = undefined;
    }
    if (
      leaf.status === "pending" &&
      (tr.status === "ok" || tr.status === "error")
    ) {
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
  const retriedAfterFinish = journal.some(
    (r, i) => r.t === "retry" && i > finishIdx,
  );
  const state: RunState =
    !finish || retriedAfterFinish
      ? "running"
      : finish.status === "completed"
        ? "completed"
        : finish.status;

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
  const endMs = settled
    ? Math.max(...all.map((l) => l.endMs ?? 0), manifest.createdAtMs)
    : undefined;
  const graph = projectRunGraph(state, all, traces, pendingApprovals);
  const detail = projectRunDetail(manifest, state, all, journal, traces, graph);

  return {
    runId: manifest.runId,
    state,
    ...(graph ? { graph } : {}),
    detail,
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

function attemptKey(seq: number, attempt: number): string {
  return `${seq}:${attempt}`;
}

function preview(value: unknown, maxBytes: number): RunTextPreview {
  const format = typeof value === "string" ? "text" : "json";
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  const truncated = Buffer.byteLength(text) > maxBytes;
  return {
    text: truncated ? boundString(text, maxBytes) : text,
    format,
    ...(truncated ? { truncated: true } : {}),
  };
}

function bounded(
  value: string | undefined,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  return Buffer.byteLength(value) > maxBytes
    ? boundString(value, maxBytes)
    : value;
}

/**
 * Latest record per attempt (highest rev) with `toolCalls` folded across the
 * attempt's records by id: each record carries the calls that changed since
 * the previous one, and older runs carried the full list every time — both
 * fold to the attempt's current list. Inputs are never mutated; a folded
 * record is a shallow copy.
 */
function latestAttemptTraces(
  traces: TraceRecord[],
): Map<string, LeafTraceRecord> {
  const latest = new Map<string, LeafTraceRecord>();
  const tools = new Map<string, Map<string, ToolCallTrace>>();
  for (const trace of traces) {
    if (trace.t !== "leaf") continue;
    const key = attemptKey(trace.seq, trace.attempt);
    let fold = tools.get(key);
    if (!fold) tools.set(key, (fold = new Map()));
    for (const tc of trace.toolCalls ?? []) fold.set(tc.id, tc);
    const current = latest.get(key);
    if (!current || trace.rev >= current.rev) latest.set(key, trace);
  }
  for (const [key, rec] of latest) {
    const fold = tools.get(key)!;
    if (fold.size > 0) latest.set(key, { ...rec, toolCalls: [...fold.values()] });
  }
  return latest;
}

function presentationSummary(trace: LeafTraceRecord | undefined): {
  title?: string;
  summary?: string;
  fields?: UiPresentation["fields"];
} {
  for (const presentation of [
    trace?.presentation?.output,
    trace?.presentation?.live,
    trace?.presentation?.input,
  ]) {
    if (!presentation) continue;
    return {
      ...(presentation.title
        ? { title: bounded(presentation.title, STATUS_SUMMARY_BYTES) }
        : {}),
      ...(presentation.summary
        ? { summary: bounded(presentation.summary, STATUS_SUMMARY_BYTES) }
        : {}),
      ...(presentation.fields?.length
        ? {
            fields: presentation.fields.map((field) => ({
              ...field,
              label: bounded(field.label, 256) ?? "",
              value: bounded(field.value, STATUS_SUMMARY_BYTES) ?? "",
            })),
          }
        : {}),
    };
  }
  return {};
}

function usageForKeys(
  keys: Iterable<string>,
  traces: Map<string, LeafTraceRecord>,
  costs: Map<string, { costUsd: number; estimated: boolean } | null>,
): {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  costBasis?: RunCostBasis;
  costUnavailable?: boolean;
} {
  let tokensIn = 0;
  let tokensOut = 0;
  let sawTokensIn = false;
  let sawTokensOut = false;
  let costUsd = 0;
  let sawCost = false;
  let costUnavailable = false;
  let sawEstimated = false;
  let sawExact = false;
  for (const key of keys) {
    const trace = traces.get(key);
    if (trace?.tokensIn !== undefined) {
      tokensIn += trace.tokensIn;
      sawTokensIn = true;
    }
    if (trace?.tokensOut !== undefined) {
      tokensOut += trace.tokensOut;
      sawTokensOut = true;
    }
    const cost = costs.get(key);
    if (cost === null) {
      costUnavailable = true;
    } else if (cost) {
      costUsd += cost.costUsd;
      sawCost = true;
      if (cost.estimated) sawEstimated = true;
      else sawExact = true;
    }
  }
  const costBasis: RunCostBasis | undefined = !sawCost
    ? undefined
    : sawEstimated && sawExact
      ? "mixed"
      : sawEstimated
        ? "estimated"
        : "exact";
  return {
    ...(sawTokensIn ? { tokensIn } : {}),
    ...(sawTokensOut ? { tokensOut } : {}),
    ...(!costUnavailable && sawCost ? { costUsd, costBasis } : {}),
    ...(costUnavailable ? { costUnavailable: true } : {}),
  };
}

function groupedLogs(
  entries: Array<{ atMs: number; message: string }>,
): RunLogDetail[] {
  const byMessage = new Map<string, RunLogDetail>();
  for (const entry of entries) {
    const message = bounded(entry.message, STATUS_LOG_BYTES) ?? "";
    const current = byMessage.get(message);
    if (current) {
      current.lastAtMs = entry.atMs;
      current.occurrences++;
    } else {
      byMessage.set(message, {
        firstAtMs: entry.atMs,
        lastAtMs: entry.atMs,
        message,
        occurrences: 1,
      });
    }
  }
  return [...byMessage.values()].sort(
    (left, right) => right.lastAtMs - left.lastAtMs,
  );
}

/**
 * Project the trace sidecar into a bounded, transport-safe native-client view.
 * Full raw traces remain available through the trace operation and report.
 */
export function projectRunDetail(
  manifest: RunManifest,
  runState: RunState,
  leaves: LeafStatus[],
  journal: JournalRecord[],
  traces: TraceRecord[],
  graph?: RunGraph,
): RunDetail {
  const leafBySeq = new Map(leaves.map((leaf) => [leaf.seq, leaf]));
  const latestTraces = latestAttemptTraces(traces);
  const attempts = new Map<
    string,
    {
      seq: number;
      attempt: number;
      startedAtMs?: number;
      status: LeafStatus["status"];
    }
  >();
  const costs = new Map<
    string,
    { costUsd: number; estimated: boolean } | null
  >();

  for (const [key, trace] of latestTraces) {
    attempts.set(key, {
      seq: trace.seq,
      attempt: trace.attempt,
      startedAtMs: trace.startMs,
      status:
        trace.status === "running"
          ? "running"
          : trace.status === "ok"
            ? "ok"
            : "error",
    });
    if (trace.costUsd === null) {
      costs.set(key, null);
    } else if (trace.costUsd !== undefined) {
      costs.set(key, {
        costUsd: trace.costUsd,
        estimated: trace.costEstimated ?? false,
      });
    }
  }
  for (const record of journal) {
    if (record.t === "attempt") {
      const key = attemptKey(record.seq, record.attempt);
      const current = attempts.get(key);
      attempts.set(key, {
        seq: record.seq,
        attempt: record.attempt,
        startedAtMs: current?.startedAtMs ?? record.atMs,
        status: current?.status ?? "pending",
      });
    } else if (record.t === "done") {
      const key = attemptKey(record.seq, record.attempt);
      const current = attempts.get(key);
      attempts.set(key, {
        seq: record.seq,
        attempt: record.attempt,
        startedAtMs: current?.startedAtMs,
        status: record.status,
      });
    } else if (record.t === "cost") {
      costs.set(
        attemptKey(record.seq, record.attempt),
        record.costUsd === null
          ? null
          : {
              costUsd: record.costUsd,
              estimated: record.costEstimated ?? false,
            },
      );
    }
  }

  for (const leaf of leaves) {
    if (leaf.attempt === undefined) continue;
    const key = attemptKey(leaf.seq, leaf.attempt);
    const current = attempts.get(key);
    attempts.set(key, {
      seq: leaf.seq,
      attempt: leaf.attempt,
      startedAtMs: current?.startedAtMs ?? leaf.startMs,
      status: leaf.status,
    });
  }

  const attemptEntries = [...attempts.entries()].sort(([, left], [, right]) => {
    const byStart =
      (right.startedAtMs ?? Number.NEGATIVE_INFINITY) -
      (left.startedAtMs ?? Number.NEGATIVE_INFINITY);
    return byStart || right.seq - left.seq || right.attempt - left.attempt;
  });
  let toolBudget = STATUS_TOOL_CALLS_TOTAL;
  const projectedAttempts = new Map<string, RunAttemptDetail>();
  for (const [key, source] of attemptEntries) {
    const leaf = leafBySeq.get(source.seq);
    if (!leaf) continue;
    const trace = latestTraces.get(key);
    const allToolCalls = trace?.toolCalls ?? [];
    const includedToolCount = Math.min(
      allToolCalls.length,
      STATUS_TOOL_CALLS_PER_ATTEMPT,
      toolBudget,
    );
    const selectedTools =
      includedToolCount > 0
        ? allToolCalls.slice(allToolCalls.length - includedToolCount)
        : [];
    toolBudget -= includedToolCount;
    const toolCalls: RunToolCallDetail[] = selectedTools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      ...(tool.startMs !== undefined ? { startMs: tool.startMs } : {}),
      ...(tool.endMs !== undefined ? { endMs: tool.endMs } : {}),
      ...(tool.input !== undefined
        ? { input: preview(tool.input, STATUS_TOOL_INPUT_BYTES) }
        : {}),
      ...(tool.result !== undefined
        ? { result: preview(tool.result, STATUS_TOOL_RESULT_BYTES) }
        : {}),
    }));
    const presentation = presentationSummary(trace);
    const cost = costs.get(key);
    projectedAttempts.set(key, {
      seq: source.seq,
      attempt: source.attempt,
      ...((trace?.id ?? leaf.id) ? { id: trace?.id ?? leaf.id } : {}),
      ...((trace?.parallelGroup ?? leaf.parallelGroup)
        ? { parallelGroup: trace?.parallelGroup ?? leaf.parallelGroup }
        : {}),
      kind: trace?.kind ?? leaf.kind,
      status: source.status,
      readOnly: trace?.readOnly ?? leaf.readOnly,
      ...((trace?.harness ?? leaf.harness)
        ? { harness: trace?.harness ?? leaf.harness }
        : {}),
      ...(trace?.model ? { model: trace.model } : {}),
      ...(trace?.reasoningEffort
        ? { reasoningEffort: trace.reasoningEffort }
        : {}),
      ...(trace?.cwd ? { cwd: trace.cwd } : {}),
      ...(trace?.sessionId ? { sessionId: trace.sessionId } : {}),
      ...((trace?.startMs ?? leaf.startMs)
        ? { startMs: trace?.startMs ?? leaf.startMs }
        : {}),
      ...((trace?.endMs ?? leaf.endMs)
        ? { endMs: trace?.endMs ?? leaf.endMs }
        : {}),
      ...(trace?.reoriented ? { reoriented: true } : {}),
      ...presentation,
      usage: {
        ...(trace?.tokensIn !== undefined ? { tokensIn: trace.tokensIn } : {}),
        ...(trace?.tokensOut !== undefined
          ? { tokensOut: trace.tokensOut }
          : {}),
        ...(cost === null
          ? { costUnavailable: true }
          : cost
          ? {
              costUsd: cost.costUsd,
              costBasis: cost.estimated
                ? ("estimated" as const)
                : ("exact" as const),
            }
          : {}),
      },
      ...(trace?.prompt !== undefined
        ? { prompt: preview(trace.prompt, STATUS_PROMPT_BYTES) }
        : {}),
      ...(trace?.output !== undefined
        ? { output: preview(trace.output, STATUS_OUTPUT_BYTES) }
        : {}),
      ...((trace?.error ?? leaf.error)
        ? {
            error: bounded(trace?.error ?? leaf.error, STATUS_OUTPUT_BYTES),
          }
        : {}),
      toolCallCount: allToolCalls.length,
      toolCalls,
      ...(allToolCalls.length > includedToolCount
        ? { toolCallsOmitted: allToolCalls.length - includedToolCount }
        : {}),
    });
  }

  const phaseOrder: Array<string | undefined> = [];
  const rememberPhase = (phase: string | undefined): void => {
    if (!phaseOrder.includes(phase)) phaseOrder.push(phase);
  };
  for (const node of graph?.nodes ?? []) rememberPhase(node.id);
  for (const leaf of leaves) rememberPhase(leaf.phase);
  if (!leaves.some((leaf) => leaf.phase === undefined)) {
    const unscoped = phaseOrder.indexOf(undefined);
    if (unscoped >= 0) phaseOrder.splice(unscoped, 1);
  }

  const attemptKeysByPhase = new Map<string | undefined, string[]>();
  const attemptDetailsByPhase = new Map<
    string | undefined,
    RunAttemptDetail[]
  >();
  for (const [key, source] of attemptEntries) {
    const phase =
      latestTraces.get(key)?.phase ?? leafBySeq.get(source.seq)?.phase;
    const keys = attemptKeysByPhase.get(phase) ?? [];
    keys.push(key);
    attemptKeysByPhase.set(phase, keys);
    const projected = projectedAttempts.get(key);
    if (projected) {
      const details = attemptDetailsByPhase.get(phase) ?? [];
      details.push(projected);
      attemptDetailsByPhase.set(phase, details);
    }
    rememberPhase(phase);
  }

  const artifactsByPhase = new Map<string | undefined, RunArtifactDetail[]>();
  const artifactSeenByPhase = new Map<string | undefined, Set<string>>();
  const artifactCounts = new Map<string | undefined, number>();
  const globalArtifacts = new Set<string>();
  let artifactBudget = STATUS_ARTIFACTS_TOTAL;
  for (const [key, source] of attemptEntries) {
    const trace = latestTraces.get(key);
    if (!trace) continue;
    const phase = trace.phase ?? leafBySeq.get(source.seq)?.phase;
    const artifacts = artifactsByPhase.get(phase) ?? [];
    const known = artifactSeenByPhase.get(phase) ?? new Set<string>();
    for (const [presentationSource, presentation] of [
      ["output", trace.presentation?.output],
      ["live", trace.presentation?.live],
      ["input", trace.presentation?.input],
    ] as const) {
      for (const [index, document] of (
        presentation?.documents ?? []
      ).entries()) {
        const identity = `${document.path}\0${document.sha256 ?? ""}`;
        if (known.has(identity)) continue;
        known.add(identity);
        globalArtifacts.add(identity);
        artifactCounts.set(phase, (artifactCounts.get(phase) ?? 0) + 1);
        if (
          artifacts.length >= STATUS_ARTIFACTS_PER_STAGE ||
          artifactBudget <= 0
        ) {
          continue;
        }
        const contentTruncated =
          document.content !== undefined &&
          Buffer.byteLength(document.content) > STATUS_DOCUMENT_BYTES;
        artifacts.push({
          id: `${trace.seq}:${trace.attempt}:${presentationSource}:${index}`,
          seq: trace.seq,
          attempt: trace.attempt,
          source: presentationSource,
          label: document.label,
          path: document.path,
          ...(document.sha256 ? { sha256: document.sha256 } : {}),
          mediaType: document.mediaType ?? "text/plain",
          ...(document.content !== undefined
            ? {
                content: contentTruncated
                  ? boundString(document.content, STATUS_DOCUMENT_BYTES)
                  : document.content,
              }
            : {}),
          ...(contentTruncated ? { contentTruncated: true } : {}),
        });
        artifactBudget--;
      }
    }
    artifactsByPhase.set(phase, artifacts);
    artifactSeenByPhase.set(phase, known);
  }

  const logEntriesByPhase = new Map<
    string | undefined,
    Array<{ atMs: number; message: string }>
  >();
  const runLogEntries: Array<{ atMs: number; message: string }> = [];
  for (const trace of traces) {
    if (trace.t === "hlog") {
      const phase = leafBySeq.get(trace.seq)?.phase;
      const entries = logEntriesByPhase.get(phase) ?? [];
      entries.push({ atMs: trace.atMs, message: trace.message });
      logEntriesByPhase.set(phase, entries);
    } else if (trace.t === "event" && trace.event.kind === "denied") {
      const phase = leafBySeq.get(trace.event.seq)?.phase;
      const entries = logEntriesByPhase.get(phase) ?? [];
      entries.push({
        atMs: trace.atMs,
        message: `Denied ${trace.event.toolName}: ${trace.event.reason}`,
      });
      logEntriesByPhase.set(phase, entries);
    } else if (trace.t === "event" && trace.event.kind === "log") {
      runLogEntries.push({ atMs: trace.atMs, message: trace.event.message });
    }
  }
  let logBudget = STATUS_LOGS_TOTAL;
  const projectedLogsByPhase = new Map<string | undefined, RunLogDetail[]>();
  for (const phase of phaseOrder) {
    const grouped = groupedLogs(logEntriesByPhase.get(phase) ?? []);
    const selectedCount = Math.min(
      grouped.length,
      STATUS_LOGS_PER_STAGE,
      logBudget,
    );
    projectedLogsByPhase.set(phase, grouped.slice(0, selectedCount));
    logBudget -= selectedCount;
  }

  const approvalById = new Map<
    string,
    {
      request: ApprovalRequest;
      resolvedAtMs?: number;
      decision?: ApprovalDecision;
    }
  >();
  for (const trace of traces) {
    if (trace.t !== "event") continue;
    if (trace.event.kind === "approval-requested") {
      approvalById.set(trace.event.approval.id, {
        request: trace.event.approval,
      });
    } else if (trace.event.kind === "approval-resolved") {
      const current = approvalById.get(trace.event.approvalId);
      if (current) {
        current.resolvedAtMs = trace.atMs;
        current.decision = trace.event.decision;
      }
    }
  }
  const approvalsByPhase = new Map<string | undefined, RunApprovalDetail[]>();
  for (const { request, resolvedAtMs, decision } of approvalById.values()) {
    const phase = leafBySeq.get(request.seq)?.phase;
    const approvals = approvalsByPhase.get(phase) ?? [];
    const action = request.actions?.find(
      (candidate) => candidate.id === decision?.action,
    );
    approvals.push({
      id: request.id,
      seq: request.seq,
      toolName: request.toolName,
      requestedAtMs: request.requestedAtMs,
      ...(resolvedAtMs !== undefined ? { resolvedAtMs } : {}),
      status: decision
        ? decision.behavior === "allow"
          ? "allowed"
          : "denied"
        : "pending",
      ...(decision?.action ? { action: decision.action } : {}),
      ...(action?.label ? { actionLabel: action.label } : {}),
      ...(decision?.message
        ? { message: bounded(decision.message, STATUS_SUMMARY_BYTES) }
        : {}),
      ...(request.presentation?.title
        ? {
            title: bounded(request.presentation.title, STATUS_SUMMARY_BYTES),
          }
        : {}),
      ...(request.presentation?.summary
        ? {
            summary: bounded(
              request.presentation.summary,
              STATUS_SUMMARY_BYTES,
            ),
          }
        : {}),
    });
    approvalsByPhase.set(phase, approvals);
  }
  for (const approvals of approvalsByPhase.values()) {
    approvals.sort((left, right) => right.requestedAtMs - left.requestedAtMs);
  }

  const phaseTimes = new Map<string, { starts: number[]; ends: number[] }>();
  for (const trace of traces) {
    if (trace.t !== "event" || trace.event.kind !== "phase") continue;
    const times = phaseTimes.get(trace.event.name) ?? {
      starts: [],
      ends: [],
    };
    if (trace.event.state === "started" || trace.event.state === undefined) {
      times.starts.push(trace.atMs);
    }
    if (
      trace.event.state === "completed" ||
      trace.event.state === "failed" ||
      trace.event.state === undefined
    ) {
      times.ends.push(trace.atMs);
    }
    phaseTimes.set(trace.event.name, times);
  }

  const graphStateByPhase = new Map(
    graph?.nodes.map((node) => [node.id, node.state]) ?? [],
  );
  const stages: RunStageDetail[] = phaseOrder.map((phase) => {
    const keys = attemptKeysByPhase.get(phase) ?? [];
    const stageLeaves = leaves.filter((leaf) => leaf.phase === phase);
    const allAttempts = attemptDetailsByPhase.get(phase) ?? [];
    const selectedAttempts = allAttempts.slice(0, STATUS_ATTEMPTS_PER_STAGE);
    const artifacts = artifactsByPhase.get(phase) ?? [];
    const logEntries = logEntriesByPhase.get(phase) ?? [];
    const logs = projectedLogsByPhase.get(phase) ?? [];
    const allApprovals = approvalsByPhase.get(phase) ?? [];
    const approvals = allApprovals.slice(0, STATUS_APPROVALS_PER_STAGE);
    const times = phase ? phaseTimes.get(phase) : undefined;
    const starts = [
      ...(times?.starts ?? []),
      ...keys
        .map((key) => latestTraces.get(key)?.startMs)
        .filter((value): value is number => value !== undefined),
    ];
    const ends = [
      ...(times?.ends ?? []),
      ...keys
        .map((key) => latestTraces.get(key)?.endMs)
        .filter((value): value is number => value !== undefined),
    ];
    const graphState = phase ? graphStateByPhase.get(phase) : undefined;
    const stageActive = graphState === "running" || graphState === "waiting";
    const metrics: RunStageMetrics = {
      callCount: stageLeaves.length,
      attemptCount: keys.length,
      failedAttemptCount: keys.filter(
        (key) => attempts.get(key)?.status === "error",
      ).length,
      toolCallCount: keys.reduce(
        (total, key) => total + (latestTraces.get(key)?.toolCalls?.length ?? 0),
        0,
      ),
      artifactCount: artifactCounts.get(phase) ?? 0,
      logCount: logEntries.length,
      approvalCount: allApprovals.length,
      ...usageForKeys(keys, latestTraces, costs),
      ...(starts.length ? { startedAtMs: Math.min(...starts) } : {}),
      ...(!stageActive && ends.length ? { endedAtMs: Math.max(...ends) } : {}),
    };
    return {
      ...(phase !== undefined ? { phase } : {}),
      metrics,
      attempts: selectedAttempts,
      ...(allAttempts.length > selectedAttempts.length
        ? { attemptsOmitted: allAttempts.length - selectedAttempts.length }
        : {}),
      artifacts,
      ...((artifactCounts.get(phase) ?? 0) > artifacts.length
        ? {
            artifactsOmitted:
              (artifactCounts.get(phase) ?? 0) - artifacts.length,
          }
        : {}),
      logs,
      ...(logEntries.length >
      logs.reduce((total, log) => total + log.occurrences, 0)
        ? {
            logsOmitted:
              logEntries.length -
              logs.reduce((total, log) => total + log.occurrences, 0),
          }
        : {}),
      approvals,
      ...(allApprovals.length > approvals.length
        ? { approvalsOmitted: allApprovals.length - approvals.length }
        : {}),
    };
  });

  const allAttemptKeys = [...attempts.keys()];
  const runLogGrouped = groupedLogs(runLogEntries);
  const runLog = runLogGrouped.slice(0, STATUS_RUN_LOGS);
  const endedAtMs =
    runState === "running"
      ? undefined
      : Math.max(
          manifest.createdAtMs,
          ...leaves.map((leaf) => leaf.endMs ?? 0),
        );
  const metrics: RunStageMetrics = {
    callCount: leaves.length,
    attemptCount: attempts.size,
    failedAttemptCount: allAttemptKeys.filter(
      (key) => attempts.get(key)?.status === "error",
    ).length,
    toolCallCount: allAttemptKeys.reduce(
      (total, key) => total + (latestTraces.get(key)?.toolCalls?.length ?? 0),
      0,
    ),
    artifactCount: globalArtifacts.size,
    logCount:
      traces.filter((trace) => trace.t === "hlog").length +
      traces.filter(
        (trace) => trace.t === "event" && trace.event.kind === "denied",
      ).length,
    approvalCount: approvalById.size,
    ...usageForKeys(allAttemptKeys, latestTraces, costs),
    startedAtMs: manifest.createdAtMs,
    ...(endedAtMs !== undefined ? { endedAtMs } : {}),
  };

  const includedRunLogs = runLog.reduce(
    (total, log) => total + log.occurrences,
    0,
  );
  return {
    metrics,
    stages,
    runLog,
    ...(runLogEntries.length > includedRunLogs
      ? { runLogOmitted: runLogEntries.length - includedRunLogs }
      : {}),
  };
}

/**
 * Build a UI-neutral graph snapshot exclusively from durable run files.
 * Consumers can render it in their own design system without parsing report
 * HTML or requiring the supervisor to still be alive.
 */
export function projectRunGraph(
  runState: RunState,
  leaves: LeafStatus[],
  traces: TraceRecord[],
  pendingApprovals = openApprovals(traces),
): RunGraph | undefined {
  const meta = programMetaFromTraces(traces);
  if (!meta) return undefined;

  const runtime = new Map<
    string,
    { scopes: Map<string, "started" | "completed" | "failed"> }
  >();
  const invocations = new Map<
    string,
    Map<string, { startedAt: number; completedAt?: number }>
  >();
  let legacyScope = 0;
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const trace = traces[traceIndex]!;
    if (trace.t !== "event" || trace.event.kind !== "phase") continue;
    const phase = runtime.get(trace.event.name) ?? { scopes: new Map() };
    if (trace.event.scope === undefined || trace.event.state === undefined) {
      const scope = `legacy-${legacyScope++}`;
      phase.scopes.set(scope, "completed");
      const phaseInvocations = invocations.get(trace.event.name) ?? new Map();
      phaseInvocations.set(scope, {
        startedAt: traceIndex,
        completedAt: traceIndex,
      });
      invocations.set(trace.event.name, phaseInvocations);
    } else {
      const scope = String(trace.event.scope);
      phase.scopes.set(scope, trace.event.state);
      const phaseInvocations = invocations.get(trace.event.name) ?? new Map();
      const invocation = phaseInvocations.get(scope);
      if (trace.event.state === "started" && !invocation) {
        phaseInvocations.set(scope, { startedAt: traceIndex });
      } else if (
        trace.event.state === "completed" &&
        invocation &&
        invocation.completedAt === undefined
      ) {
        invocation.completedAt = traceIndex;
      }
      invocations.set(trace.event.name, phaseInvocations);
    }
    runtime.set(trace.event.name, phase);
  }

  const declared = new Set(meta.graph.nodes.map((node) => node.id));
  const unplannedIds: string[] = [];
  const rememberUnplanned = (id: string | undefined): void => {
    if (id && !declared.has(id) && !unplannedIds.includes(id))
      unplannedIds.push(id);
  };
  for (const id of runtime.keys()) rememberUnplanned(id);
  for (const leaf of leaves) rememberUnplanned(leaf.phase);

  const pendingApprovalSeqs = new Set(
    pendingApprovals.map((approval) => approval.seq),
  );
  const nodes = [
    ...meta.graph.nodes,
    ...unplannedIds.map((id) => ({ id, title: id, unplanned: true as const })),
  ].map((node) => {
    if ("kind" in node && node.kind === "terminal") {
      const completed = runState === node.terminalState;
      return {
        id: node.id,
        title: node.title,
        kind: "terminal" as const,
        terminalState: node.terminalState,
        state: completed
          ? ("completed" as const)
          : runState === "running"
            ? ("pending" as const)
            : ("skipped" as const),
        visits: completed ? 1 : 0,
      };
    }

    const phase = runtime.get(node.id);
    const phaseLeaves = leaves.filter((leaf) => leaf.phase === node.id);
    const waiting = phaseLeaves.some((leaf) =>
      pendingApprovalSeqs.has(leaf.seq),
    );
    const scopeStates = [...(phase?.scopes.values() ?? [])];
    const activeScopes = scopeStates.filter(
      (value) => value === "started",
    ).length;
    const latestScope = scopeStates.at(-1);
    const visits = phase?.scopes.size ?? (phaseLeaves.length > 0 ? 1 : 0);

    let state: RunGraph["nodes"][number]["state"];
    if (waiting) state = "waiting";
    else if (
      runState === "running" &&
      (activeScopes > 0 ||
        phaseLeaves.some(
          (leaf) => leaf.status === "pending" || leaf.status === "running",
        ))
    ) {
      state = "running";
    } else if (
      latestScope === "failed" ||
      (phase === undefined &&
        phaseLeaves.some((leaf) => leaf.status === "error"))
    ) {
      state = "failed";
    } else if (visits > 0 || phaseLeaves.length > 0) {
      state = "completed";
    } else {
      state = runState === "running" ? "pending" : "skipped";
    }

    return {
      id: node.id,
      title: node.title,
      ...("kind" in node && node.kind === "gate"
        ? { kind: "gate" as const }
        : {}),
      state,
      visits,
      ...("unplanned" in node ? { unplanned: true } : {}),
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const observedInvocations = [...invocations.entries()]
    .flatMap(([nodeId, scopes]) =>
      [...scopes.values()].map((invocation) => ({
        nodeId,
        startedAt: invocation.startedAt,
      })),
    )
    .sort((left, right) => left.startedAt - right.startedAt);
  const traversals = meta.graph.edges.map(() => 0);
  const availableSources = meta.graph.edges.map(
    () => [] as typeof observedInvocations,
  );
  const incomingEdgeIndexes = new Map<string, number[]>();
  const outgoingEdgeIndexes = new Map<string, number[]>();
  for (let edgeIndex = 0; edgeIndex < meta.graph.edges.length; edgeIndex++) {
    const edge = meta.graph.edges[edgeIndex]!;
    const incoming = incomingEdgeIndexes.get(edge.to) ?? [];
    incoming.push(edgeIndex);
    incomingEdgeIndexes.set(edge.to, incoming);
    const outgoing = outgoingEdgeIndexes.get(edge.from) ?? [];
    outgoing.push(edgeIndex);
    outgoingEdgeIndexes.set(edge.from, outgoing);
  }

  for (const target of observedInvocations) {
    let selectedEdgeIndex: number | undefined;
    let selectedStartedAt = -1;
    for (const edgeIndex of incomingEdgeIndexes.get(target.nodeId) ?? []) {
      const source = availableSources[edgeIndex]!.at(-1);
      if (source && source.startedAt > selectedStartedAt) {
        selectedEdgeIndex = edgeIndex;
        selectedStartedAt = source.startedAt;
      }
    }
    if (selectedEdgeIndex !== undefined) {
      availableSources[selectedEdgeIndex]!.pop();
      traversals[selectedEdgeIndex]++;
    }
    for (const edgeIndex of outgoingEdgeIndexes.get(target.nodeId) ?? []) {
      availableSources[edgeIndex]!.push(target);
    }
  }

  const edges = meta.graph.edges.map((edge, edgeIndex) => {
    const target = nodeById.get(edge.to);
    if (target?.kind === "terminal") {
      traversals[edgeIndex] =
        target.state === "completed" &&
        nodeById.get(edge.from)?.state === "completed"
          ? 1
          : 0;
    }
    return { ...edge, traversals: traversals[edgeIndex]! };
  });

  return { nodes, edges };
}

/** Supersession: highest attempt wins; within an attempt, highest rev wins. */
/**
 * Per-record compactor for long-lived trace readers: a closed tool call never
 * changes again, so every later revision that repeats it (runs written before
 * tool-call deltas repeated all of them, every time) shares the first parsed
 * object instead of holding its own copy. Folding is unaffected: the same id
 * still maps to the same, final, state. Legacy multi-GB traces fit in memory.
 */
export function makeTraceCompactor(): (record: TraceRecord) => TraceRecord {
  const closed = new Map<string, Map<string, ToolCallTrace>>();
  return (record) => {
    if (record.t !== "leaf" || !record.toolCalls?.length) return record;
    const key = attemptKey(record.seq, record.attempt);
    let seen = closed.get(key);
    if (!seen) closed.set(key, (seen = new Map()));
    let shared = 0;
    const toolCalls = record.toolCalls.map((tc) => {
      const canonical = seen!.get(tc.id);
      if (canonical) {
        shared++;
        return canonical;
      }
      if (tc.status !== "running") seen!.set(tc.id, tc);
      return tc;
    });
    return shared > 0 ? { ...record, toolCalls } : record;
  };
}

/** Latest record per seq: the highest attempt's latest record, tool calls folded (see latestAttemptTraces). */
export function latestLeafTraces(
  traces: TraceRecord[],
): Map<number, LeafTraceRecord> {
  const best = new Map<number, LeafTraceRecord>();
  for (const rec of latestAttemptTraces(traces).values()) {
    const cur = best.get(rec.seq);
    if (!cur || rec.attempt > cur.attempt) best.set(rec.seq, rec);
  }
  return best;
}

export function openApprovals(traces: TraceRecord[]): ApprovalRequest[] {
  const open = new Map<string, ApprovalRequest>();
  for (const rec of traces) {
    if (rec.t !== "event") continue;
    if (rec.event.kind === "approval-requested")
      open.set(rec.event.approval.id, rec.event.approval);
    if (rec.event.kind === "approval-resolved")
      open.delete(rec.event.approvalId);
  }
  return [...open.values()];
}

/** Status projection from disk; pass `loaded` to reuse journal/traces already in memory. */
export function statusForRun(
  runId: string,
  loaded: { journal?: JournalRecord[]; traces?: TraceRecord[] } = {},
): RunStatus {
  return projectStatus(
    readManifest(runId),
    loaded.journal ?? readJournal(runId),
    loaded.traces ?? readTraces(runId),
  );
}
