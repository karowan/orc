/**
 * Shared contracts for orc.
 * Everything here is consumed by core, executors, harnesses, ops, and ui.
 */
import type { Readable, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ---------------------------------------------------------------------------
// Approval model (generic — each harness maps these to its native controls)
// ---------------------------------------------------------------------------
export type ApprovalMode = "manual" | "accept-edits" | "auto" | "bypass";

export interface ApprovalRequest {
  id: string;
  runId: string;
  seq: number; // leaf sequence the request came from
  toolName: string;
  input: Json;
  requestedAtMs: number;
}

export interface ApprovalDecision {
  behavior: "allow" | "deny";
  message?: string; // reason shown to the model on deny
}

// ---------------------------------------------------------------------------
// Executor — spawns leaf processes on the local host. cwd is ALWAYS a plain path.
// ---------------------------------------------------------------------------
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "ignore";
}

export interface Proc {
  stdin: Writable | null;
  stdout: Readable;
  stderr: Readable;
  /** Resolves with the exit code (or -1 on signal kill). Never rejects. */
  exited: Promise<number>;
  /** SIGTERM the process group, grace, then SIGKILL. Idempotent. */
  kill(): void;
  pid: number | undefined;
}

export interface Executor {
  spawn(cmd: string[], opts?: SpawnOptions): Proc;
  /** Run a command to completion, capturing output. */
  run(
    cmd: string[],
    opts?: SpawnOptions & { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Harness — the plugin seam. Built-ins: claude (Agent SDK), codex (app-server).
// ---------------------------------------------------------------------------
/** One model and the reasoning efforts THAT model supports (per-model). */
export interface ModelCapability {
  id: string;
  displayName?: string;
  /** Reasoning efforts valid for this model — empty if it takes no effort param. */
  reasoningEfforts: string[];
  default?: boolean;
}

export interface HarnessCapabilities {
  available: boolean;
  version?: string;
  /** Discovered natively, never hardcoded; each model carries its own efforts. */
  models: ModelCapability[];
  approvalModes: ApprovalMode[];
  structuredOutput: boolean;
  sessions: boolean;
  detail?: string; // free-text provenance ("Agent SDK model catalog", ...)
}

export interface LeafRequest {
  runId: string;
  seq: number;
  id?: string; // optional human trace label
  prompt: string;
  system: string;
  brief: string;
  schema?: Json; // JSON Schema for structured output
  model?: string;
  reasoningEffort?: string;
  readOnly: boolean;
  cwd: string; // plain path, resolved by the supervisor
  approvalMode: ApprovalMode;
  sessionId?: string;
  idleTimeoutMs?: number | false; // per-call output-idle watchdog; false disables
  /**
   * Filesystem confinement for WRITE leaves. Default false: a write leaf is an
   * unconfined subagent that can write wherever the caller can (builds write to
   * caches outside the workspace). When true, writes are confined to `cwd` plus
   * `sandboxDirs` (override dirs, e.g. cache roots). Read-only leaves deny the
   * built-in command/file mutation paths regardless — that's the readOnly
   * contract, not sandboxing. Configured hooks and MCP tools are not disabled,
   * so this is not a global side-effect sandbox.
   */
  sandbox?: boolean;
  sandboxDirs?: string[];
  /** Permit outbound network while retaining the requested filesystem sandbox. */
  networkAccess?: boolean;
}

export type HarnessEvent =
  | { kind: "tool-call-open"; id: string; name: string; input?: Json; atMs: number }
  | { kind: "tool-call-close"; id: string; status: "ok" | "error"; result?: Json; atMs: number }
  | { kind: "text"; delta: string; atMs: number }
  | { kind: "usage"; tokensIn?: number; tokensOut?: number; costUsd?: number; costEstimated?: boolean }
  | { kind: "model"; model?: string; reasoningEffort?: string }
  | { kind: "session"; sessionId: string }
  | { kind: "denied"; toolName: string; reason: string; atMs: number }
  | { kind: "result"; output: Json }
  | { kind: "error"; message: string };

export interface HarnessContext {
  executor: Executor;
  requestApproval(req: Omit<ApprovalRequest, "id" | "requestedAtMs">): Promise<ApprovalDecision>;
  signal: AbortSignal;
  log(message: string): void;
}

export interface Harness {
  readonly name: string;
  discover(ctx: { executor: Executor }): Promise<HarnessCapabilities>;
  invoke(req: LeafRequest, ctx: HarnessContext): AsyncIterable<HarnessEvent>;
  /**
   * Optional static check of a leaf's structured-output JSON Schema against
   * whatever the harness enforces at runtime (e.g. OpenAI/codex strict mode).
   * Returns human-readable problems so `orc validate` can reject a schema the
   * model would otherwise fail on at invocation time. Empty/undefined = no
   * harness-specific restriction.
   */
  lintOutputSchema?(schema: Json): string[];
}

// ---------------------------------------------------------------------------
// Runtime extensions — config-registered journaled leaf kinds (defineLeaf)
// ---------------------------------------------------------------------------
export interface ExtensionLeaf {
  name: string; // program-visible as ext.<name>(payload)
  inputSchema?: Json; // JSON Schema validated at dispatch
  readOnly: boolean;
  execute(payload: Json, ctx: HarnessContext): Promise<Json>;
}

// ---------------------------------------------------------------------------
// Program-facing thunk spec (what an agent()/ext.* call becomes)
// ---------------------------------------------------------------------------
export interface ThunkSpec {
  kind: "agent" | `ext:${string}`;
  prompt?: string; // agent kind
  payload?: Json; // ext kind
  id?: string;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  schema?: Json;
  readOnly: boolean;
  cwd?: string; // per-call override (plain path)
  phase?: string;
  idleTimeoutMs?: number | false;
  groupId?: string; // parallel() sibling-abort group
}

// ---------------------------------------------------------------------------
// Journal (Bucket A — deterministic, body-free). Append-only JSONL.
// WAL invariant: a completion record is fsynced BEFORE its value is delivered
// into the sandbox.
// ---------------------------------------------------------------------------
export interface CallRecord {
  t: "call";
  seq: number;
  kind: ThunkSpec["kind"];
  id?: string;
  phase?: string;
  readOnly: boolean;
  /** sha256 of the canonical ThunkSpec — replay verifies this. */
  specDigest: string;
}

export interface CompletionRecord {
  t: "done";
  seq: number;
  status: "ok" | "error";
  /** sha256 of the canonical result body in results/<sha>.json (ok only). */
  resultSha?: string;
  sizeBytes?: number;
  error?: string; // bounded
  attempt: number;
}

/** Durable start of one leaf attempt, written before the harness is invoked. */
export interface AttemptRecord {
  t: "attempt";
  seq: number;
  attempt: number;
  atMs: number;
}

/**
 * Latest cumulative cost reported for one attempt. Multiple records may be
 * written; replay keeps the last value for each (seq, attempt) pair.
 */
export interface CostRecord {
  t: "cost";
  seq: number;
  attempt: number;
  costUsd: number;
  costEstimated: boolean;
  atMs: number;
}

export interface FinishRecord {
  t: "finish";
  status: "completed" | "failed" | "cancelled";
  resultSha?: string;
  error?: string;
  /** Number of control records consumed by the ownership epoch that finished. */
  controlOffset?: number;
  /** Leaf whose delivered error directly became the program's terminal error. */
  errorSeq?: number;
}

/**
 * Fail-forward resume marker (append-only — history is never rewritten):
 * completion records for these seqs written BEFORE this marker are void for
 * replay; the seqs re-dispatch with a fresh attempt.
 */
export interface RetryRecord {
  t: "retry";
  seqs: number[];
  atMs: number;
}

export type JournalRecord =
  | CallRecord
  | AttemptRecord
  | CostRecord
  | CompletionRecord
  | FinishRecord
  | RetryRecord;

// ---------------------------------------------------------------------------
// Trace sidecar (Bucket B — non-deterministic detail). Append-only JSONL.
// Supersession: higher attempt wins; close beats open; higher seqNo wins.
// ---------------------------------------------------------------------------
export interface ToolCallTrace {
  id: string;
  name: string;
  input?: Json;
  result?: Json; // what the tool returned (bounded)
  startMs?: number;
  endMs?: number;
  status: "running" | "ok" | "error";
}

export interface LeafTraceRecord {
  t: "leaf";
  seq: number;
  attempt: number;
  rev: number; // monotonic revision within an attempt
  status: "running" | "ok" | "error";
  id?: string;
  phase?: string;
  kind: string;
  harness?: string;
  model?: string; // resolved model (as the harness reports it actually ran)
  reasoningEffort?: string; // resolved reasoning level
  cwd?: string;
  readOnly: boolean;
  startMs: number;
  endMs?: number;
  prompt?: string; // resolved prompt (bounded)
  brief?: string;
  output?: Json; // bounded copy of structured output
  error?: string;
  sessionId?: string;
  toolCalls?: ToolCallTrace[];
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  costEstimated?: boolean; // true = derived from a rate table (codex), not billed (claude)
  reoriented?: boolean;
}

export interface RunEventRecord {
  t: "event";
  atMs: number;
  event:
    | { kind: "log"; message: string }
    | { kind: "phase"; name: string }
    | { kind: "approval-requested"; approval: ApprovalRequest }
    | { kind: "approval-resolved"; approvalId: string; decision: ApprovalDecision; by: string }
    | { kind: "denied"; seq: number; toolName: string; reason: string };
}

/**
 * A harness's own stderr/tracing line, attributed to one leaf. Kept OUT of the
 * run's event feed (which carries only the orchestration narrative) and shown
 * in the leaf's drawer under a collapsed "Harness log" section, deduped.
 */
export interface HarnessLogRecord {
  t: "hlog";
  seq: number;
  atMs: number;
  message: string;
}

export type TraceRecord = LeafTraceRecord | RunEventRecord | HarnessLogRecord;

// ---------------------------------------------------------------------------
// Run manifest + status projection
// ---------------------------------------------------------------------------
export interface RunManifest {
  runId: string;
  name?: string;
  programPath: string;
  programSha256: string;
  cwd: string; // canonicalized
  brief: string;
  allowWrites: boolean;
  approvalMode: ApprovalMode;
  sandbox: boolean; // confine write leaves to cwd + sandboxDirs (default false)
  sandboxDirs: string[]; // extra writable roots when sandboxed (cache dirs, etc.)
  networkAccess: boolean; // outbound network inside the sandbox (default false)
  maxParallel: number;
  idleTimeoutMs: number | false;
  /** Reactive USD cap: the run fails once observed estimated cost exceeds this. */
  budgetUsd?: number;
  defaultHarness: string;
  createdAtMs: number;
  orcVersion: string;
}

export type RunState = "running" | "completed" | "failed" | "cancelled";

export interface LeafStatus {
  seq: number;
  id?: string;
  phase?: string;
  kind: string;
  status: "pending" | "running" | "ok" | "error";
  readOnly: boolean;
  harness?: string;
  startMs?: number;
  endMs?: number;
  error?: string;
  resultSha?: string;
  attempt?: number;
}

export interface RunStatus {
  runId: string;
  state: RunState;
  totalCalls: number;
  ok: number;
  failed: number;
  running: number;
  approvalsPending: number;
  leaves: LeafStatus[];
  resultSha?: string;
  error?: string;
  startedAtMs: number;
  endedAtMs?: number;
  approvalMode: ApprovalMode;
  allowWrites: boolean;
}

// ---------------------------------------------------------------------------
// Control channel (observers -> supervisor): control.jsonl appended by CLI/MCP/UI
// ---------------------------------------------------------------------------
export type ControlMessage =
  | { t: "cancel"; atMs: number }
  | { t: "approval"; approvalId: string; decision: ApprovalDecision; by: string; atMs: number };

// ---------------------------------------------------------------------------
// Policy caps
// ---------------------------------------------------------------------------
export interface Policy {
  maxCommands: number; // 128
  maxParallel: number; // 8 default; <=64
  maxPromptBytes: number; // 1 MiB
  maxResultBytes: number; // 1 MiB
  maxErrorBytes: number; // 4096
  stepBudgetPerTurn: number; // interrupt-handler invocations per drain
  memoryLimitBytes: number;
  maxStackBytes: number;
  readOnlyRetries: number; // extra in-run attempts for a failed read-only leaf
}

export const DEFAULT_POLICY: Policy = {
  maxCommands: 128,
  maxParallel: 8,
  maxPromptBytes: 1 << 20,
  maxResultBytes: 1 << 20,
  maxErrorBytes: 4096,
  stepBudgetPerTurn: 100_000,
  memoryLimitBytes: 64 << 20,
  maxStackBytes: 1 << 20,
  readOnlyRetries: 2,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class DivergenceError extends Error {
  constructor(
    message: string,
    readonly detail: { seq?: number; expected?: string; got?: string },
  ) {
    super(`replay divergence: ${message}`);
    this.name = "DivergenceError";
  }
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(`policy violation: ${message}`);
    this.name = "PolicyError";
  }
}
