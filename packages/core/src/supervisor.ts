/**
 * The run supervisor: owns one run end-to-end — program VM, leaf dispatch with
 * maxParallel, the WAL journal (fsync before delivery), the trace sidecar,
 * approvals via control.jsonl, cancellation, replay, and fail-forward resume
 * (write leaves re-dispatch as re-orienting attempts, never blind re-runs).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_POLICY,
  DivergenceError,
  PolicyError,
  type ApprovalDecision,
  type ApprovalAction,
  type ApprovalRequest,
  type CallRecord,
  type CompletionRecord,
  type ControlMessage,
  type Executor,
  type ExtensionLeaf,
  type Harness,
  type HarnessEvent,
  type Json,
  type JournalRecord,
  type LeafRequest,
  type LeafTraceRecord,
  type Policy,
  type ProgramMeta,
  type RunManifest,
  type RunStatus,
  type ThunkSpec,
  type ToolCallTrace,
  type TraceRecord,
  type UiPresentation,
} from "./contracts.js";
import {
  boundString,
  canonicalJson,
  digestJson,
  sha256Hex,
} from "./canonical.js";
import { validateAgainstSchema } from "./jsonschema.js";
import { compileProgram } from "./compile.js";
import { ProgramVM } from "./engine.js";
import {
  JsonlAppender,
  acquireLock,
  createRunDir,
  newRunId,
  readControl,
  readJournal,
  readManifest,
  readResult,
  readTraces,
  runPaths,
  withPgidRecording,
  writeResult,
  writeSupervisorPid,
  type RunPaths,
} from "./rundir.js";
import {
  openApprovals,
  projectStatus,
  resolveApprovalDecision,
  statusForRun,
} from "./status.js";

const READ_ONLY_SHUTDOWN_GRACE_MS = 1_000;
const SCHEMA_VIOLATION_PREFIX = "result fails output schema: ";
const PRESENTATION_DOCUMENT_BYTES = 128 * 1024;
const PRESENTATION_MEDIA_TYPE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+\s*=\s*(?:"[^"\r\n]*"|[A-Za-z0-9!#$%&'*+.^_`|~-]+))*$/;

function normalizeMediaType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !PRESENTATION_MEDIA_TYPE.test(value)
  ) {
    throw new Error(
      `invalid presentation document media type: ${String(value)}`,
    );
  }
  return value;
}

function normalizePresentation(
  value: UiPresentation | undefined,
): UiPresentation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("presentation must be an object");
  const presentation: UiPresentation = {};
  if (value.title !== undefined)
    presentation.title = boundString(String(value.title), 512);
  if (value.summary !== undefined)
    presentation.summary = boundString(String(value.summary), 4 * 1024);
  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields))
      throw new Error("presentation fields must be an array");
    presentation.fields = value.fields.slice(0, 32).map((field) => {
      if (!field || typeof field !== "object")
        throw new Error("presentation field must be an object");
      const kind = field.kind ?? "text";
      if (!["text", "code", "path", "url"].includes(kind)) {
        throw new Error(`unknown presentation field kind: ${String(kind)}`);
      }
      return {
        label: boundString(String(field.label), 256),
        value: boundString(String(field.value), 16 * 1024),
        kind,
      };
    });
  }
  if (value.documents !== undefined) {
    if (!Array.isArray(value.documents))
      throw new Error("presentation documents must be an array");
    presentation.documents = value.documents.slice(0, 8).map((document) => {
      if (!document || typeof document !== "object")
        throw new Error("presentation document must be an object");
      const mediaType = normalizeMediaType(document.mediaType ?? "text/plain");
      return {
        label: boundString(String(document.label), 256),
        path: boundString(String(document.path), 8 * 1024),
        ...(document.sha256 !== undefined
          ? { sha256: boundString(String(document.sha256), 256) }
          : {}),
        mediaType,
        ...(document.content !== undefined
          ? {
              content: boundString(
                String(document.content),
                PRESENTATION_DOCUMENT_BYTES,
              ),
            }
          : {}),
      };
    });
  }
  if (value.badges !== undefined) {
    if (!Array.isArray(value.badges))
      throw new Error("presentation badges must be an array");
    presentation.badges = value.badges.slice(0, 16).map((badge) => {
      if (!badge || typeof badge !== "object")
        throw new Error("presentation badge must be an object");
      const tone = badge.tone ?? "neutral";
      if (!["neutral", "success", "warning", "danger"].includes(tone)) {
        throw new Error(`unknown presentation badge tone: ${String(tone)}`);
      }
      return {
        key: boundString(String(badge.key), 128),
        label: boundString(String(badge.label), 256),
        value: boundString(String(badge.value), 2 * 1024),
        ...(badge.href !== undefined
          ? { href: boundString(String(badge.href), 8 * 1024) }
          : {}),
        tone,
      };
    });
  }
  return presentation;
}

function normalizeApprovalActions(
  actions: ApprovalAction[] | undefined,
): ApprovalAction[] | undefined {
  if (actions === undefined) return undefined;
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 8) {
    throw new Error("approval actions must contain between 1 and 8 entries");
  }
  const ids = new Set<string>();
  return actions.map((action) => {
    if (!action || typeof action !== "object")
      throw new Error("approval action must be an object");
    if (!/^[a-zA-Z0-9_-]+$/.test(action.id) || ids.has(action.id)) {
      throw new Error(
        `invalid or duplicate approval action id: ${String(action.id)}`,
      );
    }
    ids.add(action.id);
    if (action.behavior !== "allow" && action.behavior !== "deny") {
      throw new Error(`invalid behavior for approval action "${action.id}"`);
    }
    const tone = action.tone ?? "secondary";
    if (!["primary", "secondary", "danger"].includes(tone)) {
      throw new Error(`invalid tone for approval action "${action.id}"`);
    }
    return {
      id: action.id,
      label: boundString(String(action.label), 256),
      behavior: action.behavior,
      tone,
      ...(action.message
        ? {
            message: {
              label: boundString(String(action.message.label), 256),
              required: action.message.required === true,
            },
          }
        : {}),
    };
  });
}

export interface Registry {
  harnesses: Map<string, Harness>;
  extensions: Map<string, ExtensionLeaf>;
  defaultHarness: string;
  executor: Executor;
}

export interface LaunchOptions {
  programPath: string;
  cwd?: string;
  /** Opaque run-level context fanned out to every leaf. */
  context?: string;
  allowWrites?: boolean;
  approvalMode?: RunManifest["approvalMode"];
  sandbox?: boolean;
  sandboxDirs?: string[];
  /** Read-only directories granted to every leaf, for files referenced from context. */
  readDirs?: string[];
  networkAccess?: boolean;
  maxParallel?: number;
  idleTimeout?: number | false; // ms
  budgetUsd?: number; // reactive USD cap; the run fails once observed cost exceeds it
  /** Spec-time cap: a leaf whose composed context exceeds this many UTF-8 bytes fails before dispatch. */
  maxContextBytes?: number;
  name?: string;
  defaultHarness?: string;
}

export interface SupervisorHooks {
  /** Called after preflight succeeds and immediately before live dispatch. */
  onReady?(runId: string): void;
  /** Called (debounced by the caller if desired) after journal/trace appends. */
  onUpdate?(runId: string): void;
}

export const ORC_VERSION = "0.1.0";

/** Static pre-scan: does the program source declare any write leaf? */
export function sourceRequestsWrite(source: string): boolean {
  return /readOnly\s*:\s*false/.test(source);
}

/** Static pre-scan: does the program source declare any network-requesting leaf? */
export function sourceRequestsNetwork(source: string): boolean {
  return /networkAccess\s*:\s*true/.test(source);
}

export async function prepareRun(
  opts: LaunchOptions,
  registry: Registry,
): Promise<RunManifest> {
  const { bundle, sha256 } = await compileProgram(opts.programPath);
  const cwd = fs.realpathSync(path.resolve(opts.cwd ?? process.cwd()));
  if (!fs.statSync(cwd).isDirectory())
    throw new Error(`cwd is not a directory: ${cwd}`);
  if (opts.budgetUsd !== undefined && !(opts.budgetUsd > 0)) {
    throw new Error("budget must be a positive USD amount");
  }
  if (
    opts.maxContextBytes !== undefined &&
    !(Number.isInteger(opts.maxContextBytes) && opts.maxContextBytes > 0)
  ) {
    throw new Error("maxContextBytes must be a positive integer");
  }
  // Read grants resolve like cwd — against the caller's working directory — and
  // nothing more. Existence is the launcher's concern: it materialized the files
  // and owns their lifetime, so no stat/realpath here (cwd is validated only
  // because orc itself must operate there).
  const readDirs = opts.readDirs?.map((dir) => path.resolve(dir));
  const manifest: RunManifest = {
    runId: newRunId(
      opts.name ?? path.basename(opts.programPath).replace(/\.[^.]+$/, ""),
    ),
    name: opts.name,
    programPath: path.resolve(opts.programPath),
    programSha256: sha256,
    cwd,
    context: opts.context,
    allowWrites: opts.allowWrites ?? false,
    approvalMode: opts.approvalMode ?? "auto",
    sandbox: opts.sandbox ?? false,
    sandboxDirs: opts.sandboxDirs ?? [],
    readDirs,
    networkAccess: opts.networkAccess ?? false,
    maxParallel: Math.min(opts.maxParallel ?? DEFAULT_POLICY.maxParallel, 64),
    idleTimeoutMs: opts.idleTimeout ?? 15 * 60_000,
    budgetUsd: opts.budgetUsd,
    maxContextBytes: opts.maxContextBytes,
    defaultHarness: opts.defaultHarness ?? registry.defaultHarness,
    createdAtMs: Date.now(),
    orcVersion: ORC_VERSION,
  };
  createRunDir(manifest, bundle);
  return manifest;
}

interface LeafOutcome {
  seq: number;
  attempt: number;
  outcome: { status: "ok"; value: Json } | { status: "error"; error: string };
}

interface InflightLeaf {
  seq: number;
  attempt: number;
  spec: ThunkSpec;
  abort: AbortController;
  lastEventAtMs: number;
  idleTimeoutMs: number | false;
  pendingApprovalCount: number;
  groupId?: string;
}

export async function superviseRun(
  runId: string,
  registry: Registry,
  hooks: SupervisorHooks = {},
  policy: Policy = DEFAULT_POLICY,
): Promise<RunStatus> {
  const manifest = readManifest(runId);
  const paths = runPaths(runId);
  const lock = await acquireLock(paths);
  // Durable liveness trail: with the lock held, this process is the owner.
  // A hard cancel signals this pid's process group once the lock proves the
  // owner dead (or wedged past its grace), so record it before any dispatch.
  writeSupervisorPid(paths, process.pid);
  let journalOut: JsonlAppender<JournalRecord> | undefined;
  let traceOut: JsonlAppender<TraceRecord> | undefined;
  let controlWatcher: fs.FSWatcher | undefined;
  try {
    journalOut = new JsonlAppender<JournalRecord>(paths.journal);
    traceOut = new JsonlAppender<TraceRecord>(paths.traces);
    const sup = new Supervisor(
      manifest,
      paths,
      registry,
      hooks,
      policy,
      journalOut,
      traceOut,
    );
    // Watch control.jsonl so approval responses / cancels are picked up within
    // milliseconds instead of on the next poll tick — responsive UI approvals.
    fs.closeSync(fs.openSync(paths.control, "a")); // touch: create if absent, never modify
    try {
      controlWatcher = fs.watch(paths.control, () => sup.wakeForControl());
    } catch {
      /* fs.watch unsupported here; the 1s poll still covers it */
    }
    let ownershipError: Error | undefined;
    void lock.lost.catch((err: unknown) => {
      ownershipError = err instanceof Error ? err : new Error(String(err));
      sup.loseOwnership(ownershipError);
    });
    const status = await sup.run();
    if (ownershipError) throw ownershipError;
    return status;
  } finally {
    controlWatcher?.close();
    journalOut?.close();
    traceOut?.close();
    await lock.release();
    hooks.onUpdate?.(runId);
  }
}

class Supervisor {
  private vm!: ProgramVM;
  private newCalls: Array<{ seq: number; spec: ThunkSpec }> = [];
  private callRecords: CallRecord[] = []; // full history incl. journal-loaded
  private specBySeq = new Map<number, ThunkSpec>();
  private dispatchQueue: number[] = [];
  private inflight = new Map<number, InflightLeaf>();
  private completed: LeafOutcome[] = [];
  private completionSignal: (() => void) | null = null;
  private attemptBySeq = new Map<number, number>();
  private pendingApprovals = new Map<
    string,
    { approval: ApprovalRequest; settle: (decision: ApprovalDecision) => void }
  >();
  private controlConsumed = 0;
  private cancelled = false;
  private terminalError: string | null = null;
  private terminalErrorSeq: number | undefined;
  /** Latest cumulative cost for each durable leaf attempt. */
  private costByAttempt = new Map<string, number | null>();
  private leafTasks = new Set<Promise<void>>();
  private writeLeafTasks = new Set<Promise<void>>();
  private stopping = false;
  private replayCallCursor = 0; // verified against callRecords during replay
  private phaseNames: string[] = [];
  private programMetaRecorded = false;
  /** Seqs that already spent their single structured-output schema re-ask. */
  private schemaReaskUsed = new Set<number>();
  /** Violation text to append to the next attempt's LeafRequest prompt. */
  private schemaReaskViolation = new Map<number, string>();
  /** Registry executor wrapped so leaf process groups are durably recorded. */
  private readonly leafExecutor: Executor;

  constructor(
    private readonly manifest: RunManifest,
    private readonly paths: RunPaths,
    private readonly registry: Registry,
    private readonly hooks: SupervisorHooks,
    private readonly policy: Policy,
    private readonly journalOut: JsonlAppender<JournalRecord>,
    private readonly traceOut: JsonlAppender<TraceRecord>,
  ) {
    this.leafExecutor = withPgidRecording(registry.executor, paths);
  }

  async run(): Promise<RunStatus> {
    const journal = readJournal(this.manifest.runId);
    const alreadyFinished = lastFinish(journal);
    let latestFinish: Extract<JournalRecord, { t: "finish" }> | undefined;
    for (const record of journal) {
      if (record.t === "finish") latestFinish = record;
    }
    const controls = readControl(this.manifest.runId);
    // A finish durably records the old control epoch. This also survives a
    // resume that wrote its retry marker and then crashed.
    this.controlConsumed =
      latestFinish?.controlOffset === undefined
        ? alreadyFinished
          ? controls.length // legacy finish record
          : 0
        : Math.min(latestFinish.controlOffset, controls.length);
    const bundle = fs.readFileSync(this.paths.program, "utf8");
    if (sha256Hex(bundle) !== this.manifest.programSha256) {
      throw new DivergenceError(
        "program bundle does not match manifest hash",
        {},
      );
    }
    this.programMetaRecorded = readTraces(this.manifest.runId).some(
      (trace) => trace.t === "program-meta",
    );

    // Attempt starts and spend are durable so crashes cannot reset retry
    // allowance or make prior attempts free. Completion records preserve
    // compatibility with runs created before attempt-start records existed.
    for (const rec of journal) {
      if (rec.t === "attempt" || rec.t === "done") {
        this.attemptBySeq.set(
          rec.seq,
          Math.max(this.attemptBySeq.get(rec.seq) ?? 0, rec.attempt),
        );
      } else if (rec.t === "cost") {
        this.costByAttempt.set(attemptKey(rec.seq, rec.attempt), rec.costUsd);
      }
    }
    // Old runs recorded cost only in traces. Recover the latest revision for
    // each attempt, but never override a durable cost record.
    if (this.manifest.budgetUsd !== undefined) {
      const legacyCosts = new Map<
        string,
        { rev: number; cost: number | null }
      >();
      for (const tr of readTraces(this.manifest.runId)) {
        if (tr.t !== "leaf" || tr.costUsd === undefined) continue;
        const key = attemptKey(tr.seq, tr.attempt);
        const current = legacyCosts.get(key);
        if (!current || tr.rev >= current.rev)
          legacyCosts.set(key, { rev: tr.rev, cost: tr.costUsd });
      }
      for (const [key, value] of legacyCosts) {
        if (!this.costByAttempt.has(key))
          this.costByAttempt.set(key, value.cost);
      }
      this.checkBudget();
    }

    // ---- fail-forward resume bookkeeping -----------------------------------
    const priorCalls = journal.filter((r): r is CallRecord => r.t === "call");
    this.callRecords = [...priorCalls];
    const effective = effectiveCompletions(journal);
    let retrySeqs: number[] = [];
    let persistRetry = false;
    if (alreadyFinished && alreadyFinished.status !== "completed") {
      if (alreadyFinished.status === "failed") {
        // A failure followed by another call was observed and handled by the
        // program; rewriting it would rewrite history. The only safe automatic
        // retry is the exact leaf recorded as the terminal cause. Call sequence
        // is dispatch order, so a concurrent causal failure need not be the
        // highest sequence number.
        if (
          alreadyFinished.errorSeq !== undefined &&
          effective.get(alreadyFinished.errorSeq)?.record.status === "error"
        ) {
          retrySeqs = [alreadyFinished.errorSeq];
        } else if (alreadyFinished.errorSeq === undefined) {
          // Legacy finishes lack causal metadata. Keep their conservative
          // final-call string check rather than guessing across concurrency.
          const finalSeq = priorCalls.at(-1)?.seq;
          const finalCompletion =
            finalSeq === undefined
              ? undefined
              : effective.get(finalSeq)?.record;
          if (
            finalSeq !== undefined &&
            finalCompletion?.status === "error" &&
            finalCompletion.error !== undefined &&
            (alreadyFinished.error === finalCompletion.error ||
              alreadyFinished.error?.startsWith(`${finalCompletion.error}\n`))
          ) {
            retrySeqs = [finalSeq];
          }
        }
        if (retrySeqs.length === 0) {
          throw new Error(
            `run ${this.manifest.runId} has no unambiguous terminal leaf failure to retry; launch a new run`,
          );
        }
      }
      for (const seq of retrySeqs) effective.delete(seq);
      persistRetry = true;
    } else if (alreadyFinished?.status === "completed") {
      throw new Error(`run ${this.manifest.runId} already completed`);
    }

    // A hard-killed owner cannot resolve approvals in its finally path. Close
    // those historical requests before a resumed attempt can ask again.
    for (const approval of openApprovals(readTraces(this.manifest.runId))) {
      this.traceEvent({
        kind: "approval-resolved",
        approvalId: approval.id,
        decision: {
          behavior: "deny",
          message: "approval expired when the supervisor restarted",
        },
        by: "supervisor",
      });
    }

    const replaying = priorCalls.length > 0;
    try {
      // ---- boot the VM (the initial drain can already trip the step budget)
      this.vm = await ProgramVM.create(bundle, this.policy, {
        onCall: (seq, spec) => this.onCall(seq, spec, replaying),
        onLog: (m) => this.traceEvent({ kind: "log", message: m }),
        onProgramMeta: (meta) => this.traceProgramMeta(meta),
        onPhase: (name, state, scope) => {
          if (state === "started" && !this.phaseNames.includes(name))
            this.phaseNames.push(name);
          this.traceEvent({ kind: "phase", name, state, scope });
        },
      });
      return await this.execute(effective, retrySeqs, persistRetry);
    } catch (err) {
      // Policy violations (write gate, caps, step budget) are TERMINAL RUN
      // OUTCOMES, not supervisor crashes. Divergence stays a loud throw.
      if (err instanceof PolicyError) {
        this.finishFailed(err.message);
        return statusForRun(this.manifest.runId);
      }
      throw err;
    } finally {
      await this.stopAll("run ended");
      this.vm?.dispose();
    }
  }

  loseOwnership(error: Error): void {
    this.terminalError = `supervisor ownership lost: ${error.message}`;
    this.abortAll(this.terminalError);
    this.signal();
  }

  private async execute(
    effective: Map<number, { record: CompletionRecord; index: number }>,
    retrySeqs: number[],
    persistRetry: boolean,
  ): Promise<RunStatus> {
    {
      // ---- replay: deliver effective completions in journal order ----------
      const deliveryOrder = [...effective.values()].sort(
        (a, b) => a.index - b.index,
      );
      for (const { record } of deliveryOrder) {
        this.checkNewCallsAgainstJournal();
        if (!this.vm.pendingSeqs().includes(record.seq)) {
          throw new DivergenceError(
            `journal has a completion for seq ${record.seq} the program never requested (dangling completion)`,
            { seq: record.seq },
          );
        }
        this.deliver(record.seq, this.materializeOutcome(record));
      }
      this.checkNewCallsAgainstJournal();
      // Unconsumed suffix check: every prior call must have been re-made.
      if (this.replayCallCursor < this.callRecords.length) {
        const pendingReplayable = this.callRecords
          .slice(this.replayCallCursor)
          .map((c) => c.seq);
        const vmPending = new Set(this.vm.pendingSeqs());
        const nevermade = pendingReplayable.filter(
          (s) => !vmPending.has(s) && !this.specBySeq.has(s),
        );
        if (nevermade.length > 0 && this.vm.state().state !== "pending") {
          throw new DivergenceError(
            `program completed replay with unconsumed journal calls: seq ${nevermade.join(",")}`,
            {},
          );
        }
      }

      // Persist only after the candidate history replayed cleanly. A failed
      // resume must not mutate the journal into a permanently re-armed state.
      if (persistRetry) {
        this.journalOut.append({
          t: "retry",
          seqs: retrySeqs,
          atMs: Date.now(),
        });
      }

      // ---- re-dispatch undelivered calls (re-orient for writes) ------------
      for (const seq of this.vm.pendingSeqs()) {
        if (!this.dispatchQueue.includes(seq) && !this.inflight.has(seq)) {
          const spec = this.specBySeq.get(seq);
          if (spec) {
            const reorient = !spec.readOnly || retrySeqs.includes(seq);
            this.dispatchQueue.push(seq);
            if (reorient) this.markReorient(seq);
          }
        }
      }

      // ---- live loop -------------------------------------------------------
      this.hooks.onReady?.(this.manifest.runId);
      await this.liveLoop();
    }

    return statusForRun(this.manifest.runId);
  }

  // -------------------------------------------------------------------------
  private reorientSeqs = new Set<number>();
  private markReorient(seq: number): void {
    this.reorientSeqs.add(seq);
  }

  private onCall(
    seq: number,
    spec: ThunkSpec,
    verifyAgainstJournal: boolean,
  ): void {
    // ext leaves: readOnly comes from the registration, not the program.
    if (spec.kind.startsWith("ext:")) {
      const ext = this.registry.extensions.get(spec.kind.slice(4));
      if (ext) spec.readOnly = ext.readOnly;
    }
    this.specBySeq.set(seq, spec);
    this.newCalls.push({ seq, spec });
    void verifyAgainstJournal; // verification happens in checkNewCallsAgainstJournal
  }

  /** Journal (or verify) calls the VM made during the last drain. */
  private checkNewCallsAgainstJournal(): void {
    for (const { seq, spec } of this.newCalls) {
      const digest = digestJson(spec as unknown as Json);
      if (this.replayCallCursor < this.callRecords.length) {
        const expected = this.callRecords[this.replayCallCursor];
        if (expected.seq !== seq || expected.specDigest !== digest) {
          throw new DivergenceError(
            `call ${seq} does not match the journal (expected seq ${expected.seq})`,
            { seq, expected: expected.specDigest, got: digest },
          );
        }
        this.replayCallCursor++;
      } else {
        if (seq >= this.policy.maxCommands) {
          throw new PolicyError(
            `program exceeded maxCommands (${this.policy.maxCommands})`,
          );
        }
        if (
          spec.prompt &&
          Buffer.byteLength(spec.prompt) > this.policy.maxPromptBytes
        ) {
          throw new PolicyError(
            `prompt for call ${seq} exceeds ${this.policy.maxPromptBytes} bytes`,
          );
        }
        // Extension payloads are subject to the same byte cap as prompts, and
        // are validated against the extension's declared inputSchema.
        if (spec.kind.startsWith("ext:")) {
          const name = spec.kind.slice(4);
          const ext = this.registry.extensions.get(name);
          if (!ext)
            throw new PolicyError(
              `call ${seq} uses unregistered extension ext.${name}`,
            );
          const payloadBytes = Buffer.byteLength(
            canonicalJson(spec.payload ?? null),
          );
          if (payloadBytes > this.policy.maxPromptBytes) {
            throw new PolicyError(
              `ext.${name} payload for call ${seq} exceeds ${this.policy.maxPromptBytes} bytes`,
            );
          }
          if (ext.inputSchema !== undefined) {
            const problem = validateAgainstSchema(
              spec.payload ?? null,
              ext.inputSchema as Json,
            );
            if (problem)
              throw new PolicyError(
                `ext.${name} payload for call ${seq} fails inputSchema: ${problem}`,
              );
          }
        }
        if (!spec.readOnly && !this.manifest.allowWrites) {
          throw new PolicyError(
            `write-declared leaf (seq ${seq}) but the run was launched without allow_writes — fail-closed`,
          );
        }
        if (spec.networkAccess === true && !this.manifest.networkAccess) {
          throw new PolicyError(
            `network-declared leaf (seq ${seq}) but the run was launched without network_access — fail-closed`,
          );
        }
        const rec: CallRecord = {
          t: "call",
          seq,
          kind: spec.kind,
          id: spec.id,
          phase: spec.phase,
          parallelGroup: spec.parallelGroup,
          readOnly: spec.readOnly,
          specDigest: digest,
        };
        this.journalOut.append(rec); // WAL: call journaled before dispatch
        this.callRecords.push(rec);
        this.replayCallCursor++;
        this.dispatchQueue.push(seq);
      }
    }
    this.newCalls = [];
  }

  private materializeOutcome(
    rec: CompletionRecord,
  ): { status: "ok"; value: Json } | { status: "error"; error: string } {
    if (rec.status === "ok" && rec.resultSha) {
      return { status: "ok", value: readResult(this.paths, rec.resultSha) };
    }
    return { status: "error", error: rec.error ?? "unknown leaf error" };
  }

  // -------------------------------------------------------------------------
  private async liveLoop(): Promise<void> {
    for (;;) {
      this.pollControl();
      this.checkNewCallsAgainstJournal();
      if (this.terminalError) {
        this.finishFailed(this.terminalError);
        return;
      }
      if (this.cancelled) {
        this.abortAll("cancelled");
        this.journalOut.append({
          t: "finish",
          status: "cancelled",
          error: "cancelled by operator",
          controlOffset: this.controlConsumed,
        });
        this.hooks.onUpdate?.(this.manifest.runId);
        return;
      }

      const state = this.vm.state();
      if (
        state.state !== "pending" &&
        this.inflight.size === 0 &&
        this.dispatchQueue.length === 0 &&
        this.completed.length === 0
      ) {
        this.finish(state);
        return;
      }

      this.pumpDispatch();
      if (
        state.state === "pending" &&
        this.inflight.size === 0 &&
        this.dispatchQueue.length === 0 &&
        this.completed.length === 0 &&
        this.newCalls.length === 0
      ) {
        this.finishFailed(
          "program is awaiting something orc will never resolve (deadlock)",
        );
        return;
      }

      if (this.completed.length > 0) {
        // Deliver exactly one completion per quiescent drain (frozen policy).
        const next = this.completed.shift()!;
        this.deliverLive(next);
        continue;
      }

      await this.waitForSignal(1_000);
      this.checkIdleTimeouts();
    }
  }

  private pumpDispatch(): void {
    while (
      this.inflight.size < this.manifest.maxParallel &&
      this.dispatchQueue.length > 0
    ) {
      const seq = this.dispatchQueue.shift()!;
      const spec = this.specBySeq.get(seq);
      if (!spec) continue;
      const attempt = (this.attemptBySeq.get(seq) ?? 0) + 1;
      this.attemptBySeq.set(seq, attempt);
      this.journalOut.append({ t: "attempt", seq, attempt, atMs: Date.now() });
      const extensionIdleTimeout = spec.kind.startsWith("ext:")
        ? this.registry.extensions.get(spec.kind.slice(4))?.idleTimeout
        : undefined;
      const leaf: InflightLeaf = {
        seq,
        attempt,
        spec,
        abort: new AbortController(),
        lastEventAtMs: Date.now(),
        idleTimeoutMs:
          extensionIdleTimeout ??
          spec.idleTimeoutMs ??
          this.manifest.idleTimeoutMs,
        pendingApprovalCount: 0,
        groupId: spec.groupId,
      };
      this.inflight.set(seq, leaf);
      let task!: Promise<void>;
      task = this.executeLeaf(leaf)
        .then((outcome) => this.onLeafDone(leaf, outcome))
        .catch((err: unknown) =>
          this.onLeafDone(leaf, {
            status: "error",
            error: boundString(
              String(err instanceof Error ? (err.stack ?? err.message) : err),
              this.policy.maxErrorBytes,
            ),
          }),
        )
        .finally(() => {
          this.leafTasks.delete(task);
          this.writeLeafTasks.delete(task);
          this.signal();
        });
      this.leafTasks.add(task);
      if (!spec.readOnly) this.writeLeafTasks.add(task);
    }
  }

  private onLeafDone(
    leaf: InflightLeaf,
    outcome: LeafOutcome["outcome"],
  ): void {
    if (this.stopping || !this.inflight.has(leaf.seq)) return; // already aborted+settled
    this.inflight.delete(leaf.seq);

    // A structured-output schema failure earns exactly ONE re-ask: re-dispatch
    // the same call with the violation spelled out. The amendment happens at
    // LeafRequest construction (like the re-orient preamble), so the ThunkSpec
    // and its journaled digest never change, and the extra invocation rides
    // the normal attempt records — replay just delivers the final completion.
    // The bound is deliberately independent of autoRetry: schema rejections
    // are classified non-retryable below (a blind retry wastes a model call),
    // but a corrected re-ask is not blind.
    if (
      outcome.status === "error" &&
      leaf.spec.kind === "agent" &&
      leaf.spec.schema !== undefined &&
      !leaf.abort.signal.aborted &&
      outcome.error.startsWith(SCHEMA_VIOLATION_PREFIX) &&
      !this.schemaReaskUsed.has(leaf.seq)
    ) {
      this.schemaReaskUsed.add(leaf.seq);
      this.schemaReaskViolation.set(
        leaf.seq,
        outcome.error.slice(SCHEMA_VIOLATION_PREFIX.length),
      );
      this.traceEvent({
        kind: "log",
        message: `leaf ${leaf.seq} output failed schema validation → re-asking once with the violation`,
      });
      this.dispatchQueue.push(leaf.seq);
      this.signal();
      return;
    }

    // Read-only leaves retry by default. Writable leaves retry only when the
    // authored call explicitly opts in; every writable retry is re-oriented
    // against the current workspace so partial mutations are not blindly
    // repeated. Cancelled leaves are never retried.
    const autoRetry = leaf.spec.autoRetry ?? leaf.spec.readOnly;
    if (
      outcome.status === "error" &&
      autoRetry &&
      !leaf.abort.signal.aborted &&
      isRetryable(outcome.error) &&
      leaf.attempt <= this.policy.readOnlyRetries
    ) {
      if (!leaf.spec.readOnly) this.markReorient(leaf.seq);
      const mode = leaf.spec.readOnly ? "read-only" : "writable, re-orienting";
      this.traceEvent({
        kind: "log",
        message: `leaf ${leaf.seq} failed (${mode}) → retry ${leaf.attempt}/${this.policy.readOnlyRetries}`,
      });
      this.dispatchQueue.push(leaf.seq); // re-dispatch with a fresh attempt
      this.signal();
      return;
    }

    // A failed leaf no longer cancels its parallel() siblings: every lane runs
    // to completion independently and parallel() returns a per-lane outcome, so
    // one malformed lane never wastes the rest of a fan-out. (Fail-fast is still
    // available: a raw Promise.all over agent() rejects on the first failure.)
    this.completed.push({ seq: leaf.seq, attempt: leaf.attempt, outcome });
    this.signal();
  }

  private deliverLive(done: LeafOutcome): void {
    let outcome = done.outcome;
    if (outcome.status === "ok") {
      const size = Buffer.byteLength(canonicalJson(outcome.value));
      if (size > this.policy.maxResultBytes) {
        outcome = {
          status: "error",
          error: `result exceeds cap (${size} > ${this.policy.maxResultBytes} bytes)`,
        };
      }
    }
    let rec: CompletionRecord;
    if (outcome.status === "ok") {
      const { sha, sizeBytes } = writeResult(this.paths, outcome.value);
      rec = {
        t: "done",
        seq: done.seq,
        status: "ok",
        resultSha: sha,
        sizeBytes,
        attempt: done.attempt,
      };
    } else {
      rec = {
        t: "done",
        seq: done.seq,
        status: "error",
        // LeafOutcome errors are bounded exactly once at their source. Reusing
        // the same string here keeps live and replay identity identical.
        error: outcome.error,
        attempt: done.attempt,
      };
    }
    // WAL invariant: fsync the completion BEFORE delivering it into the sandbox.
    this.journalOut.append(rec, { fsync: true });
    this.deliver(done.seq, outcome);
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  /** Deliver identically during replay and live execution, including causality. */
  private deliver(
    seq: number,
    outcome: { status: "ok"; value: Json } | { status: "error"; error: string },
  ): void {
    const before = this.vm.state();
    this.vm.deliver(seq, outcome);
    if (before.state === "pending" && outcome.status === "error") {
      const after = this.vm.state();
      if (
        after.state === "error" &&
        (after.error === outcome.error ||
          after.error.startsWith(`${outcome.error}\n`))
      ) {
        this.terminalErrorSeq = seq;
      }
    }
  }

  private finish(state: ReturnType<ProgramVM["state"]>): void {
    if (state.state === "ok") {
      let result: Json;
      try {
        result = this.validateResult(state.result ?? null);
      } catch (err) {
        throw new PolicyError(String(err instanceof Error ? err.message : err));
      }
      const { sha } = writeResult(this.paths, result);
      this.journalOut.append({
        t: "finish",
        status: "completed",
        resultSha: sha,
        controlOffset: this.controlConsumed,
      });
    } else if (state.state === "error") {
      this.journalOut.append({
        t: "finish",
        status: "failed",
        error: boundString(
          state.error ?? "program failed",
          this.policy.maxErrorBytes,
        ),
        errorSeq: this.terminalErrorSeq,
        controlOffset: this.controlConsumed,
      });
    }
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private finishFailed(error: string): void {
    this.abortAll(error);
    this.journalOut.append({
      t: "finish",
      status: "failed",
      error: boundString(error, this.policy.maxErrorBytes),
      controlOffset: this.controlConsumed,
    });
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private abortAll(reason: string): void {
    for (const leaf of this.inflight.values())
      leaf.abort.abort(new Error(reason));
  }

  private async stopAll(reason: string): Promise<void> {
    this.stopping = true;
    this.abortAll(reason);
    const tasks = [...this.leafTasks];
    if (tasks.length === 0) return;
    const writeTasks = new Set(this.writeLeafTasks);
    const readTasks = tasks.filter((task) => !writeTasks.has(task));
    // Write tasks retain exclusive ownership until each one actually stops;
    // a stuck read-only sibling must not extend that requirement.
    await Promise.allSettled(writeTasks);
    if (readTasks.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(readTasks),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, READ_ONLY_SHUTDOWN_GRACE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  private async executeLeaf(
    leaf: InflightLeaf,
  ): Promise<LeafOutcome["outcome"]> {
    const { spec, seq, attempt } = leaf;
    const cwd = spec.cwd ?? this.manifest.cwd;
    // Narrow-only: the run's networkAccess grant is a ceiling. Only a literal
    // false narrows it; any other value (including a forged non-boolean via a
    // direct dispatch) gets the manifest value, so a leaf can never widen.
    const networkAccess =
      spec.networkAccess === false ? false : this.manifest.networkAccess;
    const context = composeContext(this.manifest.context, spec.context);
    const executor = this.leafExecutor;
    let rev = 0;
    const startMs = Date.now();
    const toolCalls = new Map<string, ToolCallTrace>();
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let costUsd: number | null | undefined;
    let costEstimated: boolean | undefined;
    let sessionId: string | undefined;
    let resolvedModel: string | undefined = spec.model;
    let resolvedEffort: string | undefined = spec.reasoningEffort;
    let presentationInput: UiPresentation | undefined;
    let presentationLive: UiPresentation | undefined;
    let presentationLiveDigest: string | undefined;
    let presentationOutput: UiPresentation | undefined;

    const base: Omit<LeafTraceRecord, "rev" | "status"> = {
      t: "leaf",
      seq,
      attempt,
      id: spec.id,
      phase: spec.phase,
      parallelGroup: spec.parallelGroup,
      kind: spec.kind,
      harness:
        spec.kind === "agent"
          ? (spec.harness ?? this.manifest.defaultHarness)
          : undefined,
      cwd,
      readOnly: spec.readOnly,
      networkAccess: spec.kind === "agent" ? networkAccess : undefined,
      startMs,
      prompt: spec.prompt ? boundString(spec.prompt, 16 * 1024) : undefined,
      context: context ? boundString(context, 4 * 1024) : undefined,
      reoriented: this.reorientSeqs.has(seq) || undefined,
    };
    const emitTrace = (
      status: LeafTraceRecord["status"],
      extra: Partial<LeafTraceRecord> = {},
      fsync = false,
    ) => {
      if (this.stopping) return;
      this.traceOut.append(
        {
          ...base,
          rev: rev++,
          status,
          toolCalls: [...toolCalls.values()],
          model: resolvedModel,
          reasoningEffort: resolvedEffort,
          tokensIn,
          tokensOut,
          costUsd,
          costEstimated,
          sessionId,
          ...extra,
        },
        { fsync },
      );
      this.hooks.onUpdate?.(this.manifest.runId);
    };

    let extension: ExtensionLeaf | undefined;
    if (spec.kind.startsWith("ext:")) {
      const name = spec.kind.slice(4);
      extension = this.registry.extensions.get(name);
      if (extension?.present?.input) {
        try {
          presentationInput = normalizePresentation(
            extension.present.input(spec.payload ?? null),
          );
        } catch (error) {
          this.harnessLog(
            seq,
            `extension input presentation failed: ${String(error instanceof Error ? error.message : error)}`,
          );
        }
      }
    }
    const presentation = (): LeafTraceRecord["presentation"] | undefined =>
      presentationInput || presentationLive || presentationOutput
        ? {
            ...(presentationInput ? { input: presentationInput } : {}),
            ...(presentationLive ? { live: presentationLive } : {}),
            ...(presentationOutput ? { output: presentationOutput } : {}),
          }
        : undefined;
    emitTrace("running", { presentation: presentation() });

    const ctx = {
      executor,
      signal: leaf.abort.signal,
      reportActivity: () => {
        leaf.lastEventAtMs = Date.now();
      },
      // Harness stderr/tracing is per-leaf detail, not run narrative: record it
      // as an hlog trace (drawer's collapsed "Harness log"), never as a feed event.
      log: (m: string) => {
        leaf.lastEventAtMs = Date.now();
        this.harnessLog(seq, m);
      },
      present: (value: UiPresentation) => {
        try {
          const normalized = normalizePresentation(value);
          const digest = canonicalJson(normalized as unknown as Json);
          if (digest === presentationLiveDigest) return;
          presentationLive = normalized;
          presentationLiveDigest = digest;
          emitTrace("running", { presentation: presentation() });
        } catch (error) {
          this.harnessLog(
            seq,
            `extension live presentation failed: ${String(error instanceof Error ? error.message : error)}`,
          );
        }
      },
      requestApproval: (req: Omit<ApprovalRequest, "id" | "requestedAtMs">) =>
        this.bridgeApproval(
          {
            ...req,
            runId: this.manifest.runId,
            seq,
          },
          leaf,
        ),
    };

    try {
      if (spec.kind.startsWith("ext:")) {
        const name = spec.kind.slice(4);
        const ext = extension;
        if (!ext)
          throw new Error(
            `unknown extension leaf: ext.${name} (register it in orc.config)`,
          );
        const value = this.validateResult(
          (await ext.execute(spec.payload ?? null, ctx)) ?? null,
        );
        if (ext.present?.output) {
          try {
            presentationOutput = normalizePresentation(
              ext.present.output(spec.payload ?? null, value),
            );
          } catch (error) {
            this.harnessLog(
              seq,
              `extension output presentation failed: ${String(error instanceof Error ? error.message : error)}`,
            );
          }
        }
        emitTrace(
          "ok",
          { endMs: Date.now(), output: value, presentation: presentation() },
          true,
        );
        return { status: "ok", value };
      }

      // Spec time is the only point the composed per-leaf total is knowable
      // (thunks are dynamic), so an opt-in cap is charged here — before any
      // harness invocation, and so before any model spend.
      const cap = this.manifest.maxContextBytes;
      if (cap !== undefined) {
        const contextBytes = Buffer.byteLength(context, "utf8");
        if (contextBytes > cap) {
          throw new Error(
            `leaf ${spec.id ? `"${spec.id}"` : seq} composed context is ` +
              `${contextBytes} bytes, exceeding the ${cap}-byte maxContextBytes cap`,
          );
        }
      }

      const harnessName = spec.harness ?? this.manifest.defaultHarness;
      const harness = this.registry.harnesses.get(harnessName);
      if (!harness) {
        throw new Error(
          `unknown harness "${harnessName}" (available: ${[...this.registry.harnesses.keys()].join(", ") || "none"})`,
        );
      }

      let prompt = spec.prompt ?? "";
      if (this.reorientSeqs.has(seq)) {
        prompt = (await this.reorientPreamble(executor, cwd)) + prompt;
      }
      const violation = this.schemaReaskViolation.get(seq);
      if (violation !== undefined) {
        this.schemaReaskViolation.delete(seq); // consumed by this attempt
        prompt += schemaReaskNote(violation);
      }

      const req: LeafRequest = {
        runId: this.manifest.runId,
        seq,
        id: spec.id,
        prompt,
        system: leafSystemPrompt(spec.readOnly, cwd, context),
        context: context || undefined,
        schema: spec.schema,
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        readOnly: spec.readOnly,
        cwd,
        approvalMode: this.manifest.approvalMode,
        idleTimeoutMs: leaf.idleTimeoutMs,
        sandbox: this.manifest.sandbox,
        sandboxDirs: this.manifest.sandboxDirs,
        readDirs: this.manifest.readDirs,
        networkAccess,
      };

      let result: Json | undefined;
      let errorMsg: string | undefined;
      for await (const ev of harness.invoke(req, ctx)) {
        if (this.stopping)
          throw new Error(
            `aborted: ${String(leaf.abort.signal.reason ?? "run ended")}`,
          );
        assertHarnessEvent(ev);
        leaf.lastEventAtMs = Date.now();
        this.applyEvent(ev, toolCalls, (u) => {
          tokensIn = u.tokensIn ?? tokensIn;
          tokensOut = u.tokensOut ?? tokensOut;
          if (u.costUsd === null) {
            const changed = costUsd !== null;
            costUsd = null;
            costEstimated = undefined;
            this.costByAttempt.set(attemptKey(seq, attempt), null);
            if (changed) {
              this.journalOut.append({
                t: "cost",
                seq,
                attempt,
                costUsd: null,
                atMs: Date.now(),
              });
            }
            this.checkBudget();
          } else if (u.costUsd !== undefined) {
            if (!Number.isFinite(u.costUsd) || u.costUsd < 0) {
              throw new Error(
                `harness reported invalid costUsd: ${String(u.costUsd)}`,
              );
            }
            const changed = u.costUsd !== costUsd;
            costUsd = u.costUsd;
            costEstimated = u.costEstimated ?? false;
            this.costByAttempt.set(attemptKey(seq, attempt), u.costUsd);
            if (changed) {
              this.journalOut.append({
                t: "cost",
                seq,
                attempt,
                costUsd: u.costUsd,
                costEstimated,
                atMs: Date.now(),
              });
            }
            this.checkBudget();
          }
        });
        if (ev.kind === "session") sessionId = ev.sessionId;
        if (ev.kind === "model") {
          if (ev.model) resolvedModel = ev.model;
          if (ev.reasoningEffort) resolvedEffort = ev.reasoningEffort;
        }
        if (ev.kind === "result") result = ev.output;
        if (ev.kind === "error") errorMsg = ev.message;
        if (ev.kind === "tool-call-open" || ev.kind === "tool-call-close")
          emitTrace("running");
        if (ev.kind === "denied") {
          this.traceEvent({
            kind: "denied",
            seq,
            toolName: ev.toolName,
            reason: ev.reason,
          });
        }
      }
      if (leaf.abort.signal.aborted) {
        throw new Error(
          `aborted: ${String(leaf.abort.signal.reason ?? "cancelled")}`,
        );
      }
      if (errorMsg !== undefined && result === undefined)
        throw new Error(errorMsg);
      if (result === undefined)
        throw new Error("harness produced no result event");
      result = this.validateResult(result, spec.schema);
      emitTrace("ok", { endMs: Date.now(), output: result }, true);
      return { status: "ok", value: result };
    } catch (err) {
      const msg = boundString(
        String(err instanceof Error ? (err.message ?? err) : err),
        this.policy.maxErrorBytes,
      );
      emitTrace(
        "error",
        { endMs: Date.now(), error: msg, presentation: presentation() },
        true,
      );
      return { status: "error", error: msg };
    }
  }

  private validateResult(value: Json, schema?: Json): Json {
    let canonical: string;
    try {
      canonical = canonicalJson(value);
    } catch (err) {
      throw new Error(
        `result is not valid JSON: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
    const size = Buffer.byteLength(canonical);
    if (size > this.policy.maxResultBytes) {
      throw new Error(
        `result exceeds cap (${size} > ${this.policy.maxResultBytes} bytes)`,
      );
    }
    const snapshot = JSON.parse(canonical) as Json;
    if (schema !== undefined) {
      const problem = validateAgainstSchema(snapshot, schema);
      if (problem) throw new Error(SCHEMA_VIOLATION_PREFIX + problem);
    }
    return snapshot;
  }

  private applyEvent(
    ev: HarnessEvent,
    toolCalls: Map<string, ToolCallTrace>,
    usage: (u: {
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number | null;
      costEstimated?: boolean;
    }) => void,
  ): void {
    if (ev.kind === "tool-call-open") {
      toolCalls.set(ev.id, {
        id: ev.id,
        name: ev.name,
        input: ev.input,
        startMs: ev.atMs,
        status: "running",
      });
    } else if (ev.kind === "tool-call-close") {
      const tc = toolCalls.get(ev.id);
      if (tc) {
        tc.status = ev.status;
        tc.endMs = ev.atMs;
        if (ev.result !== undefined) tc.result = ev.result;
      }
    } else if (ev.kind === "usage") {
      usage(ev);
    }
  }

  private async reorientPreamble(
    executor: Executor,
    cwd: string,
  ): Promise<string> {
    let snapshot = "";
    try {
      const status = await executor.run(["git", "status", "--porcelain"], {
        cwd,
        timeoutMs: 5_000,
      });
      const diff = await executor.run(["git", "diff", "--stat"], {
        cwd,
        timeoutMs: 5_000,
      });
      if (status.code === 0) {
        snapshot = `Observed working-tree state:\n${status.stdout.trim() || "(clean)"}\n${diff.stdout.trim()}`;
      }
    } catch {
      snapshot = "(state snapshot unavailable)";
    }
    return (
      `RE-ORIENT NOTE: A previous attempt at this task may have partially completed before being interrupted. ` +
      `${snapshot}\nInspect the current state before acting, do not blindly redo work that is already done, ` +
      `and complete the task idempotently.\n\n---\n\n`
    );
  }

  // -------------------------------------------------------------------------
  private bridgeApproval(
    req: Omit<ApprovalRequest, "id" | "requestedAtMs">,
    leaf: InflightLeaf,
  ): Promise<ApprovalDecision> {
    if (this.stopping || leaf.abort.signal.aborted) {
      return Promise.resolve({
        behavior: "deny",
        message: "leaf is no longer running",
      });
    }
    const id = `a_${leaf.seq}_${randomUUID()}`;
    const presentation = normalizePresentation(req.presentation);
    const actions = normalizeApprovalActions(req.actions);
    const approval: ApprovalRequest = {
      ...req,
      ...(presentation ? { presentation } : {}),
      ...(actions ? { actions } : {}),
      id,
      requestedAtMs: Date.now(),
    };
    this.traceEvent({ kind: "approval-requested", approval });
    leaf.pendingApprovalCount += 1;
    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (d: ApprovalDecision) => {
        this.pendingApprovals.delete(id);
        leaf.pendingApprovalCount = Math.max(0, leaf.pendingApprovalCount - 1);
        // Operator wait time is not leaf inactivity. Start a fresh idle window
        // when execution resumes after the decision.
        leaf.lastEventAtMs = Date.now();
        resolve(d);
      };
      const pending = { approval, settle };
      this.pendingApprovals.set(id, pending);
      leaf.abort.signal.addEventListener("abort", () => {
        if (this.pendingApprovals.get(id) !== pending) return;
        const decision = {
          behavior: "deny",
          message: "leaf aborted while approval was pending",
        } as const;
        this.traceEvent({
          kind: "approval-resolved",
          approvalId: id,
          decision,
          by: "supervisor",
        });
        settle(decision);
      });
    });
  }

  /** Called by the control-file watcher: drain control immediately and wake the loop. */
  wakeForControl(): void {
    try {
      this.pollControl();
    } catch {
      /* the loop will re-poll */
    }
    this.signal();
  }

  private pollControl(): void {
    const messages = readControl(this.manifest.runId);
    for (let i = this.controlConsumed; i < messages.length; i++) {
      const msg: ControlMessage = messages[i];
      if (msg.t === "cancel") this.cancelled = true;
      if (msg.t === "approval") {
        const pending = this.pendingApprovals.get(msg.approvalId);
        if (pending) {
          try {
            const decision = resolveApprovalDecision(
              pending.approval,
              msg.decision,
            );
            this.traceEvent({
              kind: "approval-resolved",
              approvalId: msg.approvalId,
              decision,
              by: msg.by,
            });
            pending.settle(decision);
          } catch (error) {
            this.harnessLog(
              pending.approval.seq,
              `invalid approval response ignored: ${String(error instanceof Error ? error.message : error)}`,
            );
          }
        }
      }
    }
    this.controlConsumed = messages.length;
  }

  private checkIdleTimeouts(): void {
    const now = Date.now();
    for (const leaf of this.inflight.values()) {
      if (
        typeof leaf.idleTimeoutMs === "number" &&
        leaf.pendingApprovalCount === 0 &&
        now - leaf.lastEventAtMs > leaf.idleTimeoutMs
      ) {
        const error = `idle timeout: no harness events for ${leaf.idleTimeoutMs}ms`;
        leaf.abort.abort(new Error(error));
        // AbortSignal is cooperative. Settle the deterministic leaf outcome
        // now; a late task result is ignored because the inflight entry is gone.
        this.onLeafDone(leaf, { status: "error", error });
      }
    }
  }

  private traceEvent(
    event: Extract<TraceRecord, { t: "event" }>["event"],
  ): void {
    this.traceOut.append(
      { t: "event", atMs: Date.now(), event },
      { fsync: false },
    );
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private traceProgramMeta(meta: ProgramMeta | undefined): void {
    if (!meta || this.programMetaRecorded) return;
    this.traceOut.append({ t: "program-meta", atMs: Date.now(), meta });
    this.programMetaRecorded = true;
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private harnessLog(seq: number, message: string): void {
    if (this.stopping) return;
    this.traceOut.append(
      { t: "hlog", seq, atMs: Date.now(), message },
      { fsync: false },
    );
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  /**
   * Budget cap: once the run's summed estimated cost passes manifest.budgetUsd,
   * fail the run terminally (all inflight leaves are aborted by finishFailed).
   * Checked on every cost update and once at start (a resume can already be over).
   */
  private checkBudget(): void {
    const budget = this.manifest.budgetUsd;
    if (budget === undefined || this.terminalError) return;
    let total = 0;
    for (const value of this.costByAttempt.values()) {
      if (value === null) {
        const msg =
          "budget cannot be enforced: cost estimate became unavailable";
        this.traceEvent({ kind: "log", message: `${msg} — failing run` });
        this.terminalError = msg;
        this.signal();
        return;
      }
      total += value;
    }
    if (total > budget) {
      const msg = `budget exceeded: estimated cost ~$${total.toFixed(2)} passed the $${budget.toFixed(2)} budget`;
      this.traceEvent({ kind: "log", message: `${msg} — failing run` });
      this.terminalError = msg;
      this.signal();
    }
  }

  private signal(): void {
    this.completionSignal?.();
    this.completionSignal = null;
  }

  private waitForSignal(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.completionSignal = null;
        resolve();
      }, maxMs);
      this.completionSignal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

// ---------------------------------------------------------------------------
function lastFinish(
  journal: JournalRecord[],
): Extract<JournalRecord, { t: "finish" }> | undefined {
  let out: Extract<JournalRecord, { t: "finish" }> | undefined;
  let outIdx = -1;
  journal.forEach((r, i) => {
    if (r.t === "finish") {
      out = r;
      outIdx = i;
    }
  });
  // A retry record after the finish re-arms the run: treat as not finished.
  const retried = journal.some((r, i) => r.t === "retry" && i > outIdx);
  return retried ? undefined : out;
}

/**
 * Effective completion per seq: completion records are void if a later retry
 * record names their seq. Returns map seq -> {record, index-in-journal}.
 */
function effectiveCompletions(
  journal: JournalRecord[],
): Map<number, { record: CompletionRecord; index: number }> {
  const voidedBefore = new Map<number, number>(); // seq -> journal index of last retry naming it
  journal.forEach((r, i) => {
    if (r.t === "retry") for (const seq of r.seqs) voidedBefore.set(seq, i);
  });
  const out = new Map<number, { record: CompletionRecord; index: number }>();
  journal.forEach((r, i) => {
    if (r.t !== "done") return;
    const voidIdx = voidedBefore.get(r.seq);
    if (voidIdx !== undefined && i < voidIdx) return; // voided by a later retry
    out.set(r.seq, { record: r, index: i });
  });
  return out;
}

/**
 * Appended to the re-asked attempt's prompt (never the spec) after a
 * structured-output schema failure. Sessions are deliberately not resumed:
 * harnesses do not guarantee session continuation, so the re-ask is a fresh
 * attempt that carries the exact violation instead.
 */
function schemaReaskNote(violation: string): string {
  return (
    `\n\n---\n\nSCHEMA CORRECTION: your previous attempt's structured output failed schema validation:\n` +
    `${violation}\n` +
    `Produce the answer again and return corrected JSON only — it must conform exactly to the output schema.`
  );
}

/** Deterministic setup errors are not worth retrying. */
function isRetryable(error: string): boolean {
  // Deterministic errors won't change on a re-run, so retrying only wastes a
  // model call and delays the real failure. Config/routing errors plus the
  // structured-output schema rejections (OpenAI/codex strict mode) are all
  // author-fixable, not transient. (Host-side schema failures get their single
  // corrective re-ask in onLeafDone before this classification applies.)
  return !/unknown harness|unknown extension|unregistered extension|fails inputSchema|allow_writes|network_access|invalid_json_schema|invalid schema|unsupported schema|additionalProperties|output[\s_-]?schema|result exceeds cap|result is not valid JSON/i.test(
    error,
  );
}

function attemptKey(seq: number, attempt: number): string {
  return `${seq}:${attempt}`;
}

function assertHarnessEvent(value: unknown): asserts value is HarnessEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness emitted a non-object event");
  }
  const event = value as Record<string, unknown>;
  const kind = event.kind;
  const stringField = (name: string): void => {
    if (typeof event[name] !== "string")
      throw new Error(`harness ${String(kind)} event has invalid ${name}`);
  };
  const optionalString = (name: string): void => {
    // null is treated as absent, not invalid: harnesses that serialize
    // optional fields naturally (JSON.dumps of a dict with a None) emit
    // null, and rejecting it killed every lane of an affected review in
    // production while the engines' outputs were already complete.
    if (event[name] === null) {
      delete (event as Record<string, unknown>)[name];
      return;
    }
    if (event[name] !== undefined && typeof event[name] !== "string") {
      throw new Error(`harness ${String(kind)} event has invalid ${name}`);
    }
  };
  const finiteNumber = (name: string, optional = false): void => {
    const v = event[name];
    if (optional && v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`harness ${String(kind)} event has invalid ${name}`);
    }
  };
  const jsonField = (name: string): void => {
    if (event[name] !== undefined) canonicalJson(event[name] as Json);
  };

  switch (kind) {
    case "tool-call-open":
      stringField("id");
      stringField("name");
      finiteNumber("atMs");
      jsonField("input");
      break;
    case "tool-call-close":
      stringField("id");
      if (event.status !== "ok" && event.status !== "error") {
        throw new Error("harness tool-call-close event has invalid status");
      }
      finiteNumber("atMs");
      jsonField("result");
      break;
    case "text":
      stringField("delta");
      finiteNumber("atMs");
      break;
    case "usage":
      finiteNumber("tokensIn", true);
      finiteNumber("tokensOut", true);
      if (event.costUsd !== null) finiteNumber("costUsd", true);
      if (
        event.costEstimated !== undefined &&
        typeof event.costEstimated !== "boolean"
      ) {
        throw new Error("harness usage event has invalid costEstimated");
      }
      break;
    case "model":
      optionalString("model");
      optionalString("reasoningEffort");
      break;
    case "session":
      stringField("sessionId");
      break;
    case "denied":
      stringField("toolName");
      stringField("reason");
      finiteNumber("atMs");
      break;
    case "result":
      if (!Object.prototype.hasOwnProperty.call(event, "output")) {
        throw new Error("harness result event has no output");
      }
      break;
    case "error":
      stringField("message");
      break;
    default:
      throw new Error(`harness emitted unknown event kind: ${String(kind)}`);
  }
}

/**
 * Run-level context first, then the thunk's, blank-line joined — shared, then
 * specific. A slot is empty when undefined or whitespace-only; participating
 * slots are carried verbatim (never trimmed, never truncated).
 */
export function composeContext(run?: string, thunk?: string): string {
  return [run, thunk]
    .filter((s): s is string => s !== undefined && s.trim() !== "")
    .join("\n\n");
}

export function leafSystemPrompt(
  readOnly: boolean,
  cwd: string,
  context: string,
): string {
  const mutation = readOnly
    ? "This task is READ-ONLY: inspect freely but do not modify files, run mutating commands, or change system state."
    : "This task may modify files under the working directory. Make only the changes the task requires.";
  const head =
    `You are an orc leaf agent. You start fresh with no memory of other leaves; everything you need is in this prompt.\n` +
    `Working directory: ${cwd}\n${mutation}`;
  return context ? `${head}\nCONTEXT:\n${context}` : head;
}

export { newRunId };
