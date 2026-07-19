/**
 * The run supervisor: owns one run end-to-end — program VM, leaf dispatch with
 * maxParallel, the WAL journal (fsync before delivery), the trace sidecar,
 * approvals via control.jsonl, cancellation, replay, and fail-forward resume
 * (write leaves re-dispatch as re-orienting attempts, never blind re-runs).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_POLICY,
  DivergenceError,
  PolicyError,
  type ApprovalDecision,
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
  type RunManifest,
  type RunStatus,
  type ThunkSpec,
  type ToolCallTrace,
  type TraceRecord,
} from "./contracts.js";
import { boundString, canonicalJson, digestJson, sha256Hex } from "./canonical.js";
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
  writeResult,
  type RunPaths,
} from "./rundir.js";
import { latestLeafTraces, projectStatus, statusForRun } from "./status.js";

export interface Registry {
  harnesses: Map<string, Harness>;
  extensions: Map<string, ExtensionLeaf>;
  defaultHarness: string;
  executorFor(host: string | undefined): Executor;
}

export interface LaunchOptions {
  programPath: string;
  cwd?: string;
  host?: string;
  brief: string;
  allowWrites?: boolean;
  approvalMode?: RunManifest["approvalMode"];
  sandbox?: boolean;
  sandboxDirs?: string[];
  maxParallel?: number;
  idleTimeout?: number | false; // ms
  budgetUsd?: number; // USD cap; the run is cancelled once estimated cost exceeds it
  name?: string;
  defaultHarness?: string;
}

export interface SupervisorHooks {
  /** Called (debounced by the caller if desired) after journal/trace appends. */
  onUpdate?(runId: string): void;
}

export const ORC_VERSION = "0.1.0";

/** Static pre-scan: does the program source declare any write leaf? */
export function sourceRequestsWrite(source: string): boolean {
  return /readOnly\s*:\s*false/.test(source);
}

export async function prepareRun(opts: LaunchOptions, registry: Registry): Promise<RunManifest> {
  const { bundle, sha256 } = await compileProgram(opts.programPath);
  // For local runs, canonicalize + validate the cwd against the local FS. For
  // remote (host) runs the cwd lives on the remote host — keep it as an
  // absolute path and let `orc doctor --host` / the leaf validate existence.
  let cwd: string;
  if (opts.host) {
    cwd = opts.cwd ?? ".";
  } else {
    cwd = fs.realpathSync(path.resolve(opts.cwd ?? process.cwd()));
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  }
  const brief = opts.brief?.trim();
  if (!brief) throw new Error("brief is required");
  if (opts.budgetUsd !== undefined && !(opts.budgetUsd > 0)) {
    throw new Error("budget must be a positive USD amount");
  }
  const manifest: RunManifest = {
    runId: newRunId(opts.name ?? path.basename(opts.programPath).replace(/\.[^.]+$/, "")),
    name: opts.name,
    programPath: path.resolve(opts.programPath),
    programSha256: sha256,
    cwd,
    host: opts.host,
    brief,
    allowWrites: opts.allowWrites ?? false,
    approvalMode: opts.approvalMode ?? "auto",
    sandbox: opts.sandbox ?? false,
    sandboxDirs: opts.sandboxDirs ?? [],
    maxParallel: Math.min(opts.maxParallel ?? DEFAULT_POLICY.maxParallel, 64),
    idleTimeoutMs: opts.idleTimeout ?? 15 * 60_000,
    budgetUsd: opts.budgetUsd,
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
  const lock = acquireLock(paths);
  const journalOut = new JsonlAppender<JournalRecord>(paths.journal);
  const traceOut = new JsonlAppender<TraceRecord>(paths.traces);
  const sup = new Supervisor(manifest, paths, registry, hooks, policy, journalOut, traceOut);
  // Watch control.jsonl so approval responses / cancels are picked up within
  // milliseconds instead of on the next poll tick — responsive UI approvals.
  fs.closeSync(fs.openSync(paths.control, "a")); // touch: create if absent, never modify
  let controlWatcher: fs.FSWatcher | undefined;
  try {
    controlWatcher = fs.watch(paths.control, () => sup.wakeForControl());
  } catch {
    /* fs.watch unsupported here; the 1s poll still covers it */
  }
  try {
    return await sup.run();
  } finally {
    controlWatcher?.close();
    journalOut.close();
    traceOut.close();
    lock.release();
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
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private approvalCounter = 0;
  private controlConsumed = 0;
  private cancelled = false;
  private terminalError: string | null = null;
  /** Latest known cost per leaf seq (exact or rate-estimated), for the budget cap. */
  private costBySeq = new Map<number, number>();
  private replayCallCursor = 0; // verified against callRecords during replay
  private phaseNames: string[] = [];

  constructor(
    private readonly manifest: RunManifest,
    private readonly paths: RunPaths,
    private readonly registry: Registry,
    private readonly hooks: SupervisorHooks,
    private readonly policy: Policy,
    private readonly journalOut: JsonlAppender<JournalRecord>,
    private readonly traceOut: JsonlAppender<TraceRecord>,
  ) {}

  async run(): Promise<RunStatus> {
    const journal = readJournal(this.manifest.runId);
    const alreadyFinished = lastFinish(journal);
    const bundle = fs.readFileSync(this.paths.program, "utf8");
    if (sha256Hex(bundle) !== this.manifest.programSha256) {
      throw new DivergenceError("program bundle does not match manifest hash", {});
    }

    // Seed the budget tracker with cost already spent by prior attempts, so a
    // resume enforces the cap against the run's TOTAL cost, not just new work.
    if (this.manifest.budgetUsd !== undefined) {
      for (const [seq, tr] of latestLeafTraces(readTraces(this.manifest.runId))) {
        if (tr.costUsd !== undefined) this.costBySeq.set(seq, tr.costUsd);
      }
      this.checkBudget();
    }

    // ---- fail-forward resume bookkeeping -----------------------------------
    const priorCalls = journal.filter((r): r is CallRecord => r.t === "call");
    this.callRecords = [...priorCalls];
    const effective = effectiveCompletions(journal);
    let retrySeqs: number[] = [];
    if (alreadyFinished && alreadyFinished.status !== "completed") {
      // Re-arm every errored/undelivered call site; void their old completions.
      retrySeqs = priorCalls
        .map((c) => c.seq)
        .filter((seq) => effective.get(seq)?.record.status !== "ok");
      for (const seq of retrySeqs) effective.delete(seq);
      if (retrySeqs.length > 0 || alreadyFinished.status === "cancelled") {
        this.journalOut.append({ t: "retry", seqs: retrySeqs, atMs: Date.now() });
      }
    } else if (alreadyFinished?.status === "completed") {
      throw new Error(`run ${this.manifest.runId} already completed`);
    }
    // Attempt numbering scans ALL completion records (including voided ones)
    // so a re-orient attempt journals as attempt N+1, never a repeat.
    for (const rec of journal) {
      if (rec.t === "done") {
        this.attemptBySeq.set(rec.seq, Math.max(this.attemptBySeq.get(rec.seq) ?? 0, rec.attempt));
      }
    }

    const replaying = priorCalls.length > 0;
    try {
      // ---- boot the VM (the initial drain can already trip the step budget)
      this.vm = await ProgramVM.create(
        bundle,
        this.policy,
        {
          onCall: (seq, spec) => this.onCall(seq, spec, replaying),
          onLog: (m) => this.traceEvent({ kind: "log", message: m }),
          onPhase: (name) => {
            if (!this.phaseNames.includes(name)) this.phaseNames.push(name);
            this.traceEvent({ kind: "phase", name });
          },
        },
      );
      return await this.execute(effective, retrySeqs);
    } catch (err) {
      // Policy violations (write gate, caps, step budget) are TERMINAL RUN
      // OUTCOMES, not supervisor crashes. Divergence stays a loud throw.
      if (err instanceof PolicyError) {
        this.finishFailed(err.message);
        return statusForRun(this.manifest.runId);
      }
      throw err;
    } finally {
      this.abortAll("run ended");
      this.vm?.dispose();
    }
  }

  private async execute(
    effective: Map<number, { record: CompletionRecord; index: number }>,
    retrySeqs: number[],
  ): Promise<RunStatus> {
    {
      // ---- replay: deliver effective completions in journal order ----------
      const deliveryOrder = [...effective.values()].sort((a, b) => a.index - b.index);
      for (const { record } of deliveryOrder) {
        this.checkNewCallsAgainstJournal();
        if (!this.vm.pendingSeqs().includes(record.seq)) {
          throw new DivergenceError(
            `journal has a completion for seq ${record.seq} the program never requested (dangling completion)`,
            { seq: record.seq },
          );
        }
        this.vm.deliver(record.seq, this.materializeOutcome(record));
      }
      this.checkNewCallsAgainstJournal();
      // Unconsumed suffix check: every prior call must have been re-made.
      if (this.replayCallCursor < this.callRecords.length) {
        const pendingReplayable = this.callRecords.slice(this.replayCallCursor).map((c) => c.seq);
        const vmPending = new Set(this.vm.pendingSeqs());
        const nevermade = pendingReplayable.filter((s) => !vmPending.has(s) && !this.specBySeq.has(s));
        if (nevermade.length > 0 && this.vm.state().state !== "pending") {
          throw new DivergenceError(
            `program completed replay with unconsumed journal calls: seq ${nevermade.join(",")}`,
            {},
          );
        }
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
      await this.liveLoop();
    }

    return statusForRun(this.manifest.runId);
  }

  // -------------------------------------------------------------------------
  private reorientSeqs = new Set<number>();
  private markReorient(seq: number): void {
    this.reorientSeqs.add(seq);
  }

  private onCall(seq: number, spec: ThunkSpec, verifyAgainstJournal: boolean): void {
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
          throw new PolicyError(`program exceeded maxCommands (${this.policy.maxCommands})`);
        }
        if (spec.prompt && Buffer.byteLength(spec.prompt) > this.policy.maxPromptBytes) {
          throw new PolicyError(`prompt for call ${seq} exceeds ${this.policy.maxPromptBytes} bytes`);
        }
        // Extension payloads are subject to the same byte cap as prompts, and
        // are validated against the extension's declared inputSchema.
        if (spec.kind.startsWith("ext:")) {
          const name = spec.kind.slice(4);
          const ext = this.registry.extensions.get(name);
          if (!ext) throw new PolicyError(`call ${seq} uses unregistered extension ext.${name}`);
          const payloadBytes = Buffer.byteLength(canonicalJson(spec.payload ?? null));
          if (payloadBytes > this.policy.maxPromptBytes) {
            throw new PolicyError(`ext.${name} payload for call ${seq} exceeds ${this.policy.maxPromptBytes} bytes`);
          }
          if (ext.inputSchema) {
            const problem = validateAgainstSchema(spec.payload ?? null, ext.inputSchema as Json);
            if (problem) throw new PolicyError(`ext.${name} payload for call ${seq} fails inputSchema: ${problem}`);
          }
        }
        if (!spec.readOnly && !this.manifest.allowWrites) {
          throw new PolicyError(
            `write-declared leaf (seq ${seq}) but the run was launched without allow_writes — fail-closed`,
          );
        }
        const rec: CallRecord = {
          t: "call",
          seq,
          kind: spec.kind,
          id: spec.id,
          phase: spec.phase,
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

  private materializeOutcome(rec: CompletionRecord): { status: "ok"; value: Json } | { status: "error"; error: string } {
    if (rec.status === "ok" && rec.resultSha) {
      return { status: "ok", value: readResult(this.paths, rec.resultSha) };
    }
    return { status: "error", error: rec.error ?? "unknown leaf error" };
  }

  // -------------------------------------------------------------------------
  private async liveLoop(): Promise<void> {
    for (;;) {
      this.checkNewCallsAgainstJournal();
      this.pumpDispatch();

      const state = this.vm.state();
      if (state.state !== "pending" && this.inflight.size === 0 && this.completed.length === 0) {
        this.finish(state);
        return;
      }
      if (this.terminalError) {
        this.finishFailed(this.terminalError);
        return;
      }
      if (this.cancelled) {
        this.abortAll("cancelled");
        this.journalOut.append({ t: "finish", status: "cancelled", error: "cancelled by operator" });
        this.hooks.onUpdate?.(this.manifest.runId);
        return;
      }
      if (
        state.state === "pending" &&
        this.inflight.size === 0 &&
        this.dispatchQueue.length === 0 &&
        this.completed.length === 0 &&
        this.newCalls.length === 0
      ) {
        this.finishFailed("program is awaiting something orc will never resolve (deadlock)");
        return;
      }

      if (this.completed.length > 0) {
        // Deliver exactly one completion per quiescent drain (frozen policy).
        const next = this.completed.shift()!;
        this.deliverLive(next);
        continue;
      }

      await this.waitForSignal(1_000);
      this.pollControl();
      this.checkIdleTimeouts();
    }
  }

  private pumpDispatch(): void {
    while (this.inflight.size < this.manifest.maxParallel && this.dispatchQueue.length > 0) {
      const seq = this.dispatchQueue.shift()!;
      const spec = this.specBySeq.get(seq);
      if (!spec) continue;
      const attempt = (this.attemptBySeq.get(seq) ?? 0) + 1;
      this.attemptBySeq.set(seq, attempt);
      const leaf: InflightLeaf = {
        seq,
        attempt,
        spec,
        abort: new AbortController(),
        lastEventAtMs: Date.now(),
        idleTimeoutMs: spec.idleTimeoutMs ?? this.manifest.idleTimeoutMs,
        groupId: spec.groupId,
      };
      this.inflight.set(seq, leaf);
      void this.executeLeaf(leaf)
        .then((outcome) => this.onLeafDone(leaf, outcome))
        .catch((err: unknown) =>
          this.onLeafDone(leaf, {
            status: "error",
            error: boundString(String(err instanceof Error ? err.stack ?? err.message : err), this.policy.maxErrorBytes),
          }),
        );
    }
  }

  private liveRetries = new Map<number, number>();

  private onLeafDone(leaf: InflightLeaf, outcome: LeafOutcome["outcome"]): void {
    if (!this.inflight.has(leaf.seq)) return; // already aborted+settled
    this.inflight.delete(leaf.seq);

    // Supervisor retry table: a failed READ-ONLY leaf gets a bounded number of
    // fresh attempts before it (and its parallel group) is failed. Write leaves
    // are never auto-retried (a retry would double-apply mutations); a cancelled
    // leaf is not retried either.
    if (
      outcome.status === "error" &&
      leaf.spec.readOnly &&
      !leaf.abort.signal.aborted &&
      isRetryable(outcome.error) &&
      (this.liveRetries.get(leaf.seq) ?? 0) < this.policy.readOnlyRetries
    ) {
      this.liveRetries.set(leaf.seq, (this.liveRetries.get(leaf.seq) ?? 0) + 1);
      this.traceEvent({ kind: "log", message: `leaf ${leaf.seq} failed (read-only) → retry ${this.liveRetries.get(leaf.seq)}/${this.policy.readOnlyRetries}` });
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
        outcome = { status: "error", error: `result exceeds cap (${size} > ${this.policy.maxResultBytes} bytes)` };
      }
    }
    let rec: CompletionRecord;
    if (outcome.status === "ok") {
      const { sha, sizeBytes } = writeResult(this.paths, outcome.value);
      rec = { t: "done", seq: done.seq, status: "ok", resultSha: sha, sizeBytes, attempt: done.attempt };
    } else {
      rec = {
        t: "done",
        seq: done.seq,
        status: "error",
        error: boundString(outcome.error, this.policy.maxErrorBytes),
        attempt: done.attempt,
      };
    }
    // WAL invariant: fsync the completion BEFORE delivering it into the sandbox.
    this.journalOut.append(rec, { fsync: true });
    this.vm.deliver(done.seq, outcome);
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private finish(state: ReturnType<ProgramVM["state"]>): void {
    if (state.state === "ok") {
      const { sha } = writeResult(this.paths, state.result ?? null);
      this.journalOut.append({ t: "finish", status: "completed", resultSha: sha });
    } else if (state.state === "error") {
      this.journalOut.append({
        t: "finish",
        status: "failed",
        error: boundString(state.error ?? "program failed", this.policy.maxErrorBytes),
      });
    }
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private finishFailed(error: string): void {
    this.abortAll(error);
    this.journalOut.append({ t: "finish", status: "failed", error: boundString(error, this.policy.maxErrorBytes) });
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private abortAll(reason: string): void {
    for (const leaf of this.inflight.values()) leaf.abort.abort(new Error(reason));
  }

  // -------------------------------------------------------------------------
  private async executeLeaf(leaf: InflightLeaf): Promise<LeafOutcome["outcome"]> {
    const { spec, seq, attempt } = leaf;
    const host = spec.host ?? this.manifest.host;
    const cwd = spec.cwd ?? this.manifest.cwd;
    const executor = this.registry.executorFor(host);
    let rev = 0;
    const startMs = Date.now();
    const toolCalls = new Map<string, ToolCallTrace>();
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let costUsd: number | undefined;
    let costEstimated: boolean | undefined;
    let sessionId: string | undefined;
    let resolvedModel: string | undefined = spec.model;
    let resolvedEffort: string | undefined = spec.reasoningEffort;

    const base: Omit<LeafTraceRecord, "rev" | "status"> = {
      t: "leaf",
      seq,
      attempt,
      id: spec.id,
      phase: spec.phase,
      kind: spec.kind,
      harness: spec.kind === "agent" ? (spec.harness ?? this.manifest.defaultHarness) : undefined,
      host,
      cwd,
      readOnly: spec.readOnly,
      startMs,
      prompt: spec.prompt ? boundString(spec.prompt, 16 * 1024) : undefined,
      brief: boundString(this.manifest.brief, 4 * 1024),
      reoriented: this.reorientSeqs.has(seq) || undefined,
    };
    const emitTrace = (status: LeafTraceRecord["status"], extra: Partial<LeafTraceRecord> = {}, fsync = false) => {
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
    emitTrace("running");

    const ctx = {
      executor,
      signal: leaf.abort.signal,
      // Harness stderr/tracing is per-leaf detail, not run narrative: record it
      // as an hlog trace (drawer's collapsed "Harness log"), never as a feed event.
      log: (m: string) => this.harnessLog(seq, m),
      requestApproval: (req: Omit<ApprovalRequest, "id" | "requestedAtMs">) => this.bridgeApproval(req, leaf),
    };

    try {
      if (spec.kind.startsWith("ext:")) {
        const name = spec.kind.slice(4);
        const ext = this.registry.extensions.get(name);
        if (!ext) throw new Error(`unknown extension leaf: ext.${name} (register it in orc.config)`);
        const value = (await ext.execute(spec.payload ?? null, ctx)) ?? null;
        emitTrace("ok", { endMs: Date.now(), output: value }, true);
        return { status: "ok", value };
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

      const req: LeafRequest = {
        runId: this.manifest.runId,
        seq,
        id: spec.id,
        prompt,
        system: leafSystemPrompt(spec.readOnly, cwd, this.manifest.brief),
        brief: this.manifest.brief,
        schema: spec.schema,
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        readOnly: spec.readOnly,
        cwd,
        host,
        approvalMode: this.manifest.approvalMode,
        idleTimeoutMs: leaf.idleTimeoutMs,
        sandbox: this.manifest.sandbox,
        sandboxDirs: this.manifest.sandboxDirs,
      };

      let result: Json | undefined;
      let errorMsg: string | undefined;
      for await (const ev of harness.invoke(req, ctx)) {
        leaf.lastEventAtMs = Date.now();
        this.applyEvent(ev, toolCalls, (u) => {
          tokensIn = u.tokensIn ?? tokensIn;
          tokensOut = u.tokensOut ?? tokensOut;
          if (u.costUsd !== undefined) {
            costUsd = u.costUsd;
            costEstimated = u.costEstimated ?? false;
            this.costBySeq.set(seq, u.costUsd);
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
        if (ev.kind === "tool-call-open" || ev.kind === "tool-call-close") emitTrace("running");
        if (ev.kind === "denied") {
          this.traceEvent({ kind: "denied", seq, toolName: ev.toolName, reason: ev.reason });
        }
      }
      if (leaf.abort.signal.aborted) {
        throw new Error(`aborted: ${String(leaf.abort.signal.reason ?? "cancelled")}`);
      }
      if (errorMsg !== undefined && result === undefined) throw new Error(errorMsg);
      if (result === undefined) throw new Error("harness produced no result event");
      emitTrace("ok", { endMs: Date.now(), output: result }, true);
      return { status: "ok", value: result };
    } catch (err) {
      const msg = boundString(String(err instanceof Error ? (err.message ?? err) : err), this.policy.maxErrorBytes);
      emitTrace("error", { endMs: Date.now(), error: msg }, true);
      return { status: "error", error: msg };
    }
  }

  private applyEvent(
    ev: HarnessEvent,
    toolCalls: Map<string, ToolCallTrace>,
    usage: (u: { tokensIn?: number; tokensOut?: number; costUsd?: number; costEstimated?: boolean }) => void,
  ): void {
    if (ev.kind === "tool-call-open") {
      toolCalls.set(ev.id, { id: ev.id, name: ev.name, input: ev.input, startMs: ev.atMs, status: "running" });
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

  private async reorientPreamble(executor: Executor, cwd: string): Promise<string> {
    let snapshot = "";
    try {
      const status = await executor.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 5_000 });
      const diff = await executor.run(["git", "diff", "--stat"], { cwd, timeoutMs: 5_000 });
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
    const id = `a_${leaf.seq}_${this.approvalCounter++}`;
    const approval: ApprovalRequest = { ...req, id, requestedAtMs: Date.now() };
    this.traceEvent({ kind: "approval-requested", approval });
    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (d: ApprovalDecision) => {
        this.pendingApprovals.delete(id);
        resolve(d);
      };
      this.pendingApprovals.set(id, settle);
      leaf.abort.signal.addEventListener("abort", () =>
        settle({ behavior: "deny", message: "leaf aborted while approval was pending" }),
      );
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
        const settle = this.pendingApprovals.get(msg.approvalId);
        if (settle) {
          this.traceEvent({ kind: "approval-resolved", approvalId: msg.approvalId, decision: msg.decision, by: msg.by });
          settle(msg.decision);
        }
      }
    }
    this.controlConsumed = messages.length;
  }

  private checkIdleTimeouts(): void {
    const now = Date.now();
    for (const leaf of this.inflight.values()) {
      if (typeof leaf.idleTimeoutMs === "number" && now - leaf.lastEventAtMs > leaf.idleTimeoutMs) {
        leaf.abort.abort(new Error(`idle timeout: no harness events for ${leaf.idleTimeoutMs}ms`));
      }
    }
  }

  private traceEvent(event: Extract<TraceRecord, { t: "event" }>["event"]): void {
    this.traceOut.append({ t: "event", atMs: Date.now(), event }, { fsync: false });
    this.hooks.onUpdate?.(this.manifest.runId);
  }

  private harnessLog(seq: number, message: string): void {
    this.traceOut.append({ t: "hlog", seq, atMs: Date.now(), message }, { fsync: false });
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
    for (const v of this.costBySeq.values()) total += v;
    if (total > budget) {
      const msg = `budget exceeded: estimated cost ~$${total.toFixed(2)} passed the $${budget.toFixed(2)} budget`;
      this.traceEvent({ kind: "log", message: `${msg} — cancelling run` });
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
function lastFinish(journal: JournalRecord[]): Extract<JournalRecord, { t: "finish" }> | undefined {
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

/** Deterministic setup errors are not worth retrying. */
function isRetryable(error: string): boolean {
  // Deterministic errors won't change on a re-run, so retrying only wastes a
  // model call and delays the real failure. Config/routing errors plus the
  // structured-output schema rejections (OpenAI/codex strict mode) are all
  // author-fixable, not transient.
  return !/unknown harness|unregistered extension|fails inputSchema|not supported for remote|allow_writes|invalid_json_schema|invalid schema|unsupported schema|additionalProperties|outputSchema/i.test(
    error,
  );
}

export function leafSystemPrompt(readOnly: boolean, cwd: string, brief: string): string {
  const mutation = readOnly
    ? "This task is READ-ONLY: inspect freely but do not modify files, run mutating commands, or change system state."
    : "This task may modify files under the working directory. Make only the changes the task requires.";
  return (
    `You are an orc leaf agent. You start fresh with no memory of other leaves; everything you need is in this prompt.\n` +
    `Working directory: ${cwd}\n${mutation}\n` +
    `SHARED CONTEXT (brief):\n${brief}`
  );
}

export { newRunId };
