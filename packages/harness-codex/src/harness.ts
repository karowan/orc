/**
 * codex harness: drives `codex app-server` (codex-cli 0.144.x) over
 * newline-delimited JSON-RPC on stdio. The server process is spawned through
 * the provided executor.
 *
 * Wire protocol notes (verified empirically against codex-cli 0.144.5 and its
 * `codex app-server generate-json-schema` output):
 *
 *   client -> server:  initialize, (notify) initialized, thread/start,
 *                      thread/resume, turn/start, turn/interrupt, model/list
 *   server -> client notifications: thread/started, turn/started,
 *                      item/started, item/completed, item/agentMessage/delta,
 *                      thread/tokenUsage/updated, turn/completed, error
 *   server -> client requests (approvals), current family:
 *                      item/commandExecution/requestApproval -> {decision:
 *                        "accept"|"acceptForSession"|"decline"|"cancel"}
 *                      item/fileChange/requestApproval        -> same enum
 *                      legacy family (still in the protocol schema):
 *                      execCommandApproval / applyPatchApproval -> {decision:
 *                        "approved"|"approved_for_session"|"denied"|"abort"}
 *
 * Approval-mode mapping (design name -> wire name):
 *   manual       -> approvalPolicy "on-request"; bridge every request
 *   accept-edits -> approvalPolicy "on-request"; auto-accept fileChange
 *                   approvals confined to req.cwd, bridge the rest
 *   auto / bypass -> approvalPolicy "never"
 * Filesystem policy is orthogonal to approvals (see below): read-only leaf ->
 * "read-only"; a default write leaf OMITS the sandbox param so codex uses the
 * user's own ~/.codex config (never more power than the caller); `sandbox` ->
 * "workspace-write" with cwd + sandboxDirs as runtime workspace roots;
 * explicit `bypass` -> "danger-full-access".
 */
import * as path from "node:path";
import type {
  ApprovalDecision,
  Executor,
  Harness,
  HarnessCapabilities,
  HarnessContext,
  HarnessEvent,
  Json,
  LeafRequest,
  ModelCapability,
  Proc,
} from "@karowanorg/orc-core";
import {
  estimateCostUsd,
  loadCostRates,
  type ModelRate,
} from "@karowanorg/orc-core";
import { JsonRpcClient } from "./rpc.js";
import {
  extractFirstJsonObject,
  lintStrictOutputSchema,
  normalizeSchema,
  restoreOptionalNulls,
} from "./schema.js";

export interface CodexHarnessOptions {
  /** Command spawned through the executor. Default: ["codex", "app-server"]. */
  appServerCommand?: string[];
  /** Wait after turn/interrupt before killing the process. Default 2000ms. */
  interruptGraceMs?: number;
  clientInfo?: { name: string; version: string };
  /**
   * Per-model rate table (USD per 1M tokens) for cost ESTIMATION, since codex's
   * app-server reports tokens but no dollar figure. Defaults to the built-in
   * DEFAULT_COST_RATES (overridable via ORC_COST_RATES / config costRates).
   */
  costRates?: Record<string, ModelRate>;
}

// --- wire result fragments (loosely typed; only fields we consume) ---------
interface ThreadStartResult {
  thread?: { id?: string };
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}
interface TurnStartResult {
  turn?: { id?: string };
}
interface TurnWire {
  id?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string } | null;
}
interface ThreadItemWire {
  type?: string;
  id?: string;
  text?: string;
  phase?: string;
  status?: string;
  command?: unknown;
  cwd?: unknown;
  query?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  changes?: unknown;
}
interface ModelListResult {
  data?: Array<{
    id?: string;
    model?: string;
    displayName?: string;
    hidden?: boolean;
    isDefault?: boolean;
    supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
  }>;
}

/** Simple push-based async event queue backing the invoke() iterator. */
class EventQueue {
  private items: HarnessEvent[] = [];
  private waiter: (() => void) | undefined;
  private done = false;

  push(ev: HarnessEvent): void {
    if (this.done) return;
    this.items.push(ev);
    this.waiter?.();
  }

  end(): void {
    this.done = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : {};
}

/** Is `candidate` lexically inside (or equal to) directory `root`? */
function withinDir(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, candidate));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** Collect changed file paths from a fileChange item / legacy fileChanges map. */
function changedPaths(changes: unknown): string[] {
  if (Array.isArray(changes)) {
    return changes
      .map((c) => asRecord(c).path)
      .filter((p): p is string => typeof p === "string");
  }
  if (changes !== null && typeof changes === "object")
    return Object.keys(changes);
  return [];
}

export function createCodexHarness(options: CodexHarnessOptions = {}): Harness {
  const appServerCommand = options.appServerCommand ?? ["codex", "app-server"];
  const interruptGraceMs = options.interruptGraceMs ?? 2000;
  const clientInfo = options.clientInfo ?? { name: "orc", version: "0.1.0" };
  const initializeCapabilities = {
    experimentalApi: true,
    requestAttestation: false,
  };
  const costRates = loadCostRates(options.costRates);

  async function discover(ctx: {
    executor: Executor;
  }): Promise<HarnessCapabilities> {
    const base: HarnessCapabilities = {
      available: false,
      models: [],
      approvalModes: ["manual", "accept-edits", "auto", "bypass"],
      structuredOutput: true,
      sessions: true,
    };
    const ver = await ctx.executor
      .run(["codex", "--version"], { timeoutMs: 15_000 })
      .catch(() => ({ code: -1, stdout: "", stderr: "" }));
    if (ver.code !== 0) return { ...base, detail: "codex binary not found" };
    base.available = true;
    base.version = ver.stdout.trim().replace(/^codex(-cli)?\s+/, "");

    // Native discovery: model/list on a short-lived app-server session. (The
    // generate-json-schema output was checked and carries NO model/effort
    // enums — ReasoningEffort is a free string there — so model/list is the
    // only native source of truth.)
    try {
      const models = await modelList(ctx.executor);
      if (models.length > 0) {
        return { ...base, models, detail: "codex app-server model/list" };
      }
    } catch {
      // fall through to config.toml
    }
    const fallback = await configTomlModel(ctx.executor);
    return {
      ...base,
      models: fallback
        ? [
            {
              id: fallback,
              // Documented effort ladder for codex-cli 0.14x, used only when
              // the live catalog is unreachable.
              reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
            },
          ]
        : [],
      detail: fallback
        ? "fallback: model default from $CODEX_HOME/config.toml (app-server model/list unavailable)"
        : "fallback: app-server model/list unavailable and no $CODEX_HOME/config.toml model",
    };
  }

  async function modelList(executor: Executor): Promise<ModelCapability[]> {
    const proc = executor.spawn(appServerCommand);
    try {
      const rpc = new JsonRpcClient(proc);
      const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("discover timeout")),
                ms,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      await withTimeout(
        rpc.request("initialize", {
          clientInfo,
          capabilities: initializeCapabilities,
        }),
        20_000,
      );
      rpc.notify("initialized", {});
      const res = await withTimeout(
        rpc.request<ModelListResult>("model/list", {}),
        20_000,
      );
      const visible = (res.data ?? []).filter(
        (m) => !m.hidden && typeof m.id === "string",
      );
      // Default model first.
      visible.sort(
        (a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false),
      );
      return visible.map((m) => {
        const efforts: string[] = [];
        for (const e of m.supportedReasoningEfforts ?? []) {
          if (
            typeof e.reasoningEffort === "string" &&
            !efforts.includes(e.reasoningEffort)
          ) {
            efforts.push(e.reasoningEffort);
          }
        }
        return {
          id: m.id!,
          displayName: m.displayName,
          reasoningEfforts: efforts,
          default: m.isDefault === true ? true : undefined,
        };
      });
    } finally {
      proc.kill();
    }
  }

  async function configTomlModel(
    executor: Executor,
  ): Promise<string | undefined> {
    try {
      const codexHome = (
        await executor.run([
          "sh",
          "-c",
          'if [ -n "$CODEX_HOME" ]; then printf %s "$CODEX_HOME"; elif [ -n "$HOME" ]; then printf %s "$HOME/.codex"; fi',
        ])
      ).stdout.trim();
      if (!codexHome) return undefined;
      const toml = await executor.readFile(path.join(codexHome, "config.toml"));
      const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml);
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  function invoke(
    req: LeafRequest,
    ctx: HarnessContext,
  ): AsyncIterable<HarnessEvent> {
    const queue = new EventQueue();
    void runTurn(req, ctx, queue); // runTurn reports its own errors via the queue
    return queue;
  }

  async function runTurn(
    req: LeafRequest,
    ctx: HarnessContext,
    queue: EventQueue,
  ): Promise<void> {
    // --- approval-mode mapping (design -> wire) ----------------------------
    const approvalPolicy =
      req.approvalMode === "manual" || req.approvalMode === "accept-edits"
        ? "on-request"
        : "never";
    // Filesystem policy — never gives a leaf MORE power than the user's own
    // codex, orthogonal to the approval policy:
    // - read-only leaf         -> "read-only"      (orc's readOnly restriction)
    // - write leaf + sandbox   -> "workspace-write"(explicit confinement, less power)
    // - write leaf + bypass    -> "danger-full-access" (explicit max, opt-in)
    // - write leaf (default)   -> OMIT the param → codex uses the user's own
    //   $CODEX_HOME/config.toml default, so a leaf has exactly the caller's power.
    const sandbox: string | undefined = req.readOnly
      ? "read-only"
      : req.sandbox
        ? "workspace-write"
        : req.approvalMode === "bypass"
          ? "danger-full-access"
          : undefined;
    const runtimeWorkspaceRoots =
      req.sandbox && !req.readOnly
        ? [
            ...new Set(
              [req.cwd, ...(req.sandboxDirs ?? [])].map((root) =>
                path.normalize(
                  path.isAbsolute(root) ? root : path.resolve(req.cwd, root),
                ),
              ),
            ),
          ]
        : undefined;
    // Sandboxed write leaves get an EXPLICIT network override both ways —
    // omitting it would inherit the user's $CODEX_HOME/config.toml default.
    // Read-only leaves never carry network config.
    const networkConfig =
      req.sandbox && !req.readOnly
        ? {
            config: {
              sandbox_workspace_write: {
                network_access: req.networkAccess === true,
              },
            },
          }
        : undefined;

    const proc: Proc = ctx.executor.spawn(appServerCommand, { cwd: req.cwd });
    let turnId: string | undefined;
    let threadId: string | undefined;
    let resolvedModel = req.model;
    let resolvedServiceTier: string | null | undefined;
    let accumulatedInputTokens = 0;
    let accumulatedOutputTokens = 0;
    let accumulatedCostUsd = 0;
    let costEstimateKnown = true;
    let previousUsageTotal: string | undefined;
    let lastErrorMessage: string | undefined;
    const itemsById = new Map<string, ThreadItemWire>();
    const messageBuffers = new Map<string, string>();
    let finalAnswer: string | undefined;
    let lastAgentMessage: string | undefined;

    // Transport-idle watchdog. Before declaring a quiet active turn dead, ask
    // app-server to read its thread; a response proves the server is live
    // without altering the turn.
    let idleTimer: NodeJS.Timeout | undefined;
    let idleProbeTimer: NodeJS.Timeout | undefined;
    let idleFired = false;
    let idlePauseDepth = 0;
    let requestIdleProbe: (() => void) | undefined;
    const clearIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleProbeTimer) clearTimeout(idleProbeTimer);
      idleTimer = undefined;
      idleProbeTimer = undefined;
    };
    const armIdle = (): void => {
      if (
        typeof req.idleTimeoutMs !== "number" ||
        idlePauseDepth > 0 ||
        idleFired
      ) {
        return;
      }
      clearIdle();
      idleProbeTimer = setTimeout(() => {
        idleProbeTimer = undefined;
        requestIdleProbe?.();
      }, Math.max(1, Math.floor(req.idleTimeoutMs * 0.75)));
      idleProbeTimer.unref?.();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        idleFired = true;
        queue.push({
          kind: "error",
          message: `idle timeout: no app-server output for ${req.idleTimeoutMs}ms`,
        });
        proc.kill();
      }, req.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const noteTransportActivity = (): void => {
      ctx.reportActivity();
      armIdle();
    };
    const pauseIdle = (): void => {
      idlePauseDepth += 1;
      clearIdle();
    };
    const resumeIdle = (): void => {
      idlePauseDepth = Math.max(0, idlePauseDepth - 1);
      if (idlePauseDepth === 0) armIdle();
    };

    // Forward server stderr (tracing logs) to the supervisor log. Stderr is
    // also real app-server activity even though JSON-RPC uses stdout.
    let errBuf = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      noteTransportActivity();
      errBuf += chunk;
      let idx: number;
      while ((idx = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, idx).trim();
        errBuf = errBuf.slice(idx + 1);
        if (line) ctx.log(line); // hlog is already per-leaf + harness-attributed
      }
    });

    proc.stdout.on("data", noteTransportActivity);
    armIdle();

    let resolveTurn: (turn: TurnWire) => void;
    const turnDone = new Promise<TurnWire>(
      (resolve) => (resolveTurn = resolve),
    );

    const onNotification = (method: string, rawParams: unknown): void => {
      const params = asRecord(rawParams);
      if (
        typeof params.threadId === "string" &&
        threadId &&
        params.threadId !== threadId
      )
        return;
      switch (method) {
        case "item/started": {
          const item = asRecord(params.item) as ThreadItemWire;
          if (typeof item.id === "string") itemsById.set(item.id, item);
          const atMs = Date.now();
          switch (item.type) {
            case "commandExecution":
              queue.push({
                kind: "tool-call-open",
                id: item.id ?? "",
                name: "command",
                input: {
                  command: item.command ?? null,
                  cwd: item.cwd ?? null,
                } as Json,
                atMs,
              });
              break;
            case "fileChange":
              queue.push({
                kind: "tool-call-open",
                id: item.id ?? "",
                name: "edit",
                input: { changes: (item.changes ?? null) as Json },
                atMs,
              });
              break;
            case "webSearch":
              queue.push({
                kind: "tool-call-open",
                id: item.id ?? "",
                name: "webSearch",
                input: { query: (item.query ?? null) as Json },
                atMs,
              });
              break;
            case "mcpToolCall":
              queue.push({
                kind: "tool-call-open",
                id: item.id ?? "",
                name: "mcpToolCall",
                input: {
                  server: (item.server ?? null) as Json,
                  tool: (item.tool ?? null) as Json,
                  arguments: (item.arguments ?? null) as Json,
                },
                atMs,
              });
              break;
            default:
              break; // userMessage / reasoning / agentMessage etc: no tool event
          }
          break;
        }
        case "item/completed": {
          const item = asRecord(params.item) as ThreadItemWire;
          if (typeof item.id === "string") itemsById.set(item.id, item);
          const atMs = Date.now();
          switch (item.type) {
            case "commandExecution":
            case "fileChange":
            case "webSearch":
            case "mcpToolCall": {
              const failed =
                item.status === "failed" || item.status === "declined";
              queue.push({
                kind: "tool-call-close",
                id: item.id ?? "",
                status: failed ? "error" : "ok",
                atMs,
              });
              break;
            }
            case "agentMessage": {
              const text = typeof item.text === "string" ? item.text : "";
              lastAgentMessage = text;
              if (item.phase === "final_answer" || item.phase === undefined)
                finalAnswer = text;
              break;
            }
            default:
              break;
          }
          break;
        }
        case "item/agentMessage/delta": {
          const delta = typeof params.delta === "string" ? params.delta : "";
          const itemId = typeof params.itemId === "string" ? params.itemId : "";
          messageBuffers.set(
            itemId,
            (messageBuffers.get(itemId) ?? "") + delta,
          );
          if (delta) queue.push({ kind: "text", delta, atMs: Date.now() });
          break;
        }
        case "thread/tokenUsage/updated": {
          const tokenUsage = asRecord(params.tokenUsage);
          const total = asRecord(tokenUsage.total);
          const totalFingerprint = JSON.stringify(
            [
              "inputTokens",
              "cachedInputTokens",
              "cacheWriteInputTokens",
              "outputTokens",
              "reasoningOutputTokens",
              "totalTokens",
            ].map((field) =>
              typeof total[field] === "number" ? total[field] : null,
            ),
          );
          if (totalFingerprint === previousUsageTotal) break;
          previousUsageTotal = totalFingerprint;

          const usage = asRecord(tokenUsage.last);
          const inputTokens =
            typeof usage.inputTokens === "number"
              ? usage.inputTokens
              : undefined;
          const outputTokens =
            typeof usage.outputTokens === "number"
              ? usage.outputTokens
              : undefined;
          const cachedInputTokens =
            typeof usage.cachedInputTokens === "number"
              ? usage.cachedInputTokens
              : undefined;
          const cacheWriteInputTokens =
            typeof usage.cacheWriteInputTokens === "number"
              ? usage.cacheWriteInputTokens
              : undefined;
          const hasRequestUsage =
            inputTokens !== undefined ||
            outputTokens !== undefined ||
            cachedInputTokens !== undefined ||
            cacheWriteInputTokens !== undefined;
          if (!hasRequestUsage) {
            costEstimateKnown = false;
            queue.push({ kind: "usage", costUsd: null });
            break;
          }

          accumulatedInputTokens += inputTokens ?? 0;
          accumulatedOutputTokens += outputTokens ?? 0;
          const requestCostUsd = estimateCostUsd(
            costRates,
            resolvedModel,
            {
              inputTokens,
              cachedInputTokens,
              cacheWriteInputTokens,
              outputTokens,
            },
            resolvedServiceTier,
          );
          if (requestCostUsd === undefined) costEstimateKnown = false;
          else if (costEstimateKnown) accumulatedCostUsd += requestCostUsd;

          queue.push({
            kind: "usage",
            tokensIn: accumulatedInputTokens,
            tokensOut: accumulatedOutputTokens,
            costUsd: costEstimateKnown ? accumulatedCostUsd : null,
            ...(costEstimateKnown ? { costEstimated: true } : {}),
          });
          break;
        }
        case "turn/completed": {
          resolveTurn(asRecord(params.turn) as TurnWire);
          break;
        }
        case "error": {
          const message = asRecord(params.error).message;
          if (typeof message === "string") lastErrorMessage = message;
          break;
        }
        default:
          break;
      }
    };

    const bridgeApproval = async (
      toolName: string,
      input: Json,
    ): Promise<ApprovalDecision> => {
      pauseIdle();
      let decision: ApprovalDecision;
      try {
        decision = await ctx.requestApproval({
          runId: req.runId,
          seq: req.seq,
          toolName,
          input,
        });
      } finally {
        resumeIdle();
      }
      if (decision.behavior === "deny") {
        queue.push({
          kind: "denied",
          toolName,
          reason: decision.message ?? "denied by operator",
          atMs: Date.now(),
        });
      }
      return decision;
    };

    const denyReadOnly = (toolName: string): ApprovalDecision => {
      queue.push({
        kind: "denied",
        toolName,
        reason: "read-only leaf denied approval",
        atMs: Date.now(),
      });
      return { behavior: "deny" };
    };

    const decideFileChange = async (
      paths: string[],
      grantRoot: unknown,
      input: Json,
    ) => {
      if (req.readOnly) return denyReadOnly("edit");
      const confined =
        paths.length > 0 &&
        paths.every((p) => withinDir(p, req.cwd)) &&
        (typeof grantRoot !== "string" || withinDir(grantRoot, req.cwd));
      if (req.approvalMode === "accept-edits" && confined) {
        return { behavior: "allow" } as ApprovalDecision;
      }
      if (req.approvalMode === "auto" || req.approvalMode === "bypass") {
        // approvalPolicy is "never" for these modes; if the server asks
        // anyway, honor the mode's intent and allow.
        return { behavior: "allow" } as ApprovalDecision;
      }
      return bridgeApproval("edit", input);
    };

    const onServerRequest = async (
      method: string,
      rawParams: unknown,
    ): Promise<unknown> => {
      const params = asRecord(rawParams);
      switch (method) {
        // --- current (v2) approval family --------------------------------
        case "item/commandExecution/requestApproval": {
          const item =
            typeof params.itemId === "string"
              ? itemsById.get(params.itemId)
              : undefined;
          const decision = req.readOnly
            ? denyReadOnly("command")
            : req.approvalMode === "auto" || req.approvalMode === "bypass"
              ? ({ behavior: "allow" } as ApprovalDecision)
              : await bridgeApproval("command", {
                  command: (params.command ?? item?.command ?? null) as Json,
                  cwd: (params.cwd ?? item?.cwd ?? null) as Json,
                  reason: (params.reason ?? null) as Json,
                });
          return {
            decision: decision.behavior === "allow" ? "accept" : "decline",
          };
        }
        case "item/fileChange/requestApproval": {
          const item =
            typeof params.itemId === "string"
              ? itemsById.get(params.itemId)
              : undefined;
          const paths = changedPaths(item?.changes);
          const decision = await decideFileChange(paths, params.grantRoot, {
            changes: (item?.changes ?? null) as Json,
            paths,
            reason: (params.reason ?? null) as Json,
          });
          return {
            decision: decision.behavior === "allow" ? "accept" : "decline",
          };
        }
        // --- legacy approval family (older servers) ----------------------
        case "execCommandApproval": {
          const decision = req.readOnly
            ? denyReadOnly("command")
            : req.approvalMode === "auto" || req.approvalMode === "bypass"
              ? ({ behavior: "allow" } as ApprovalDecision)
              : await bridgeApproval("command", {
                  command: (params.command ?? null) as Json,
                  cwd: (params.cwd ?? null) as Json,
                  reason: (params.reason ?? null) as Json,
                });
          return {
            decision: decision.behavior === "allow" ? "approved" : "denied",
          };
        }
        case "applyPatchApproval": {
          const paths = changedPaths(params.fileChanges);
          const decision = await decideFileChange(paths, params.grantRoot, {
            changes: (params.fileChanges ?? null) as Json,
            paths,
            reason: (params.reason ?? null) as Json,
          });
          return {
            decision: decision.behavior === "allow" ? "approved" : "denied",
          };
        }
        default:
          throw new Error(`unsupported server request: ${method}`);
      }
    };

    const rpc = new JsonRpcClient(proc, {
      onNotification,
      onServerRequest,
      log: ctx.log,
    });
    requestIdleProbe = () => {
      if (!threadId) return;
      void rpc
        .request("thread/read", { threadId, includeTurns: false })
        .catch(() => undefined);
    };

    // Cancellation: best-effort turn/interrupt, then kill.
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      if (threadId && turnId) {
        rpc
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => undefined);
      }
      setTimeout(() => proc.kill(), interruptGraceMs).unref?.();
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await rpc.request("initialize", {
        clientInfo,
        capabilities: initializeCapabilities,
      });
      rpc.notify("initialized", {});

      const developerInstructions = req.system.trim() || undefined;

      let threadResult: ThreadStartResult;
      if (req.sessionId) {
        threadResult = await rpc.request<ThreadStartResult>("thread/resume", {
          threadId: req.sessionId,
          cwd: req.cwd,
          ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
          approvalPolicy,
          ...(sandbox !== undefined ? { sandbox } : {}), // omit -> inherit user's config default
          ...(networkConfig ?? {}),
          ...(developerInstructions ? { developerInstructions } : {}),
        });
        threadId = threadResult.thread?.id ?? req.sessionId;
      } else {
        threadResult = await rpc.request<ThreadStartResult>("thread/start", {
          cwd: req.cwd,
          ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
          approvalPolicy,
          ...(sandbox !== undefined ? { sandbox } : {}), // omit -> inherit user's config default
          ...(networkConfig ?? {}),
          ...(developerInstructions ? { developerInstructions } : {}),
        });
        threadId = threadResult.thread?.id;
        if (!threadId) throw new Error("thread/start returned no thread id");
      }
      resolvedModel = req.model ?? threadResult.model;
      resolvedServiceTier = threadResult.serviceTier;
      queue.push({
        kind: "model",
        model: resolvedModel,
        reasoningEffort:
          req.reasoningEffort ?? threadResult.reasoningEffort ?? undefined,
      });
      queue.push({ kind: "session", sessionId: threadId });

      const turnStarted = await rpc.request<TurnStartResult>("turn/start", {
        threadId,
        input: [{ type: "text", text: req.prompt }],
        ...(req.model ? { model: req.model } : {}),
        ...(req.reasoningEffort ? { effort: req.reasoningEffort } : {}),
        ...(req.schema !== undefined
          ? { outputSchema: normalizeSchema(req.schema) }
          : {}),
      });
      turnId = turnStarted.turn?.id;

      const outcome = await Promise.race([
        turnDone.then((turn) => ({ turn })),
        proc.exited.then((code) => ({ exitCode: code })),
      ]);

      if ("exitCode" in outcome) {
        if (idleFired) return; // idle watchdog already reported the error
        queue.push({
          kind: "error",
          message: aborted
            ? "cancelled: turn aborted by supervisor"
            : `app-server exited before turn completion (code ${outcome.exitCode})${
                lastErrorMessage ? `: ${lastErrorMessage}` : ""
              }`,
        });
        return;
      }

      const turn = outcome.turn;
      if (turn.status === "completed") {
        const message = finalAnswer ?? lastAgentMessage ?? "";
        if (req.schema !== undefined) {
          let output: Json | undefined;
          try {
            output = JSON.parse(message) as Json;
          } catch {
            output = extractFirstJsonObject(message);
          }
          if (output === undefined) {
            queue.push({
              kind: "error",
              message: `structured output parse failed: ${message.slice(0, 500)}`,
            });
            return;
          }
          queue.push({
            kind: "result",
            output: restoreOptionalNulls(output, req.schema),
          });
        } else {
          queue.push({ kind: "result", output: { text: message } });
        }
      } else if (turn.status === "interrupted") {
        queue.push({ kind: "error", message: "cancelled: turn interrupted" });
      } else {
        queue.push({
          kind: "error",
          message: `turn failed: ${turn.error?.message ?? lastErrorMessage ?? "unknown error"}`,
        });
      }
    } catch (err) {
      // Must run before the finally ends the queue, or the event is dropped.
      queue.push({ kind: "error", message: String(err) });
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      clearIdle();
      proc.kill();
      queue.end();
    }
  }

  return {
    name: "codex",
    discover,
    invoke,
    lintOutputSchema: lintStrictOutputSchema,
  };
}

/** Default codex harness bound to the real `codex app-server` binary. */
export const codexHarness: Harness = createCodexHarness();
