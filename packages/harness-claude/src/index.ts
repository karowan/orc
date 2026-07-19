/**
 * The claude harness — built-in harness #1.
 *
 * Two transports behind one contract:
 * - LOCAL (no host): @anthropic-ai/claude-agent-sdk `query()` — richest path:
 *   canUseTool approval bridging, settingSources (user's own settings are the
 *   policy substrate), native structured output, session resume. Note the SDK
 *   still SPAWNS the bundled CLI as a subprocess (verified in sdk source) — the
 *   SDK owns that child's lifecycle; cancellation goes through abortController.
 * - REMOTE (host set): the claude CLI over the executor (ssh), speaking the
 *   same stream-json protocol. v1 remote supports approval modes auto/bypass
 *   only (manual/accept-edits need an approval back-channel — fail closed).
 *
 * Approval-mode mapping (verified against SDK 0.3.215 types):
 * - manual       -> permissionMode "default"  + canUseTool -> requestApproval
 * - accept-edits -> permissionMode "acceptEdits" + canUseTool for the rest
 * - auto         -> permissionMode "dontAsk"  (deny-and-report; NOT "default",
 *                   which prompts — the verified correction)
 * - bypass       -> permissionMode "bypassPermissions" + allowDangerouslySkipPermissions
 *
 * Read-only scoping uses disallowedTools (NOT bare allowedTools, which
 * auto-approves before canUseTool — the verified interplay defect).
 */
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * orc does NOT bundle the Claude Code CLI — the system `claude` is a
 * prerequisite. Point the Agent SDK at it (never its own bundled binary, which
 * we don't install). Override with ORC_CLAUDE_PATH.
 */
let cachedClaudePath: string | null | undefined;
export function systemClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath ?? undefined;
  const env = process.env.ORC_CLAUDE_PATH;
  if (env && existsSync(env)) return (cachedClaudePath = env);
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(cmd, ["claude"], { encoding: "utf8" }).split("\n")[0]?.trim();
    cachedClaudePath = found && existsSync(found) ? found : null;
  } catch {
    cachedClaudePath = null;
  }
  return cachedClaudePath ?? undefined;
}
import type {
  Executor,
  Harness,
  HarnessCapabilities,
  HarnessContext,
  HarnessEvent,
  Json,
  LeafRequest,
  ModelCapability,
} from "@orc/core";

const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

export const claudeHarness: Harness = {
  name: "claude",

  async discover({ executor }: { executor: Executor }): Promise<HarnessCapabilities> {
    const version = await executor.run(["claude", "--version"], { timeoutMs: 15_000 }).catch(() => null);
    if (!version || version.code !== 0) {
      return {
        available: false,
        models: [],
        approvalModes: [],
        structuredOutput: false,
        sessions: false,
        detail: "claude CLI not found on this executor",
      };
    }
    let models: ModelCapability[] = [];
    if (!executor.host) {
      // Native catalog via the SDK's supportedModels control request. Each
      // ModelInfo carries its OWN supportedEffortLevels (per-model). Point at
      // the system claude — orc doesn't ship the SDK's bundled CLI.
      try {
        const claudePath = systemClaudePath();
        const q = query({
          prompt: "",
          options: { maxTurns: 0, ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}) },
        });
        // NB: clear the deadline timer once the race settles — an uncleared
        // setTimeout keeps the Node event loop alive, so the CLI would print
        // its result and then appear to hang until the timer fired.
        let deadline: NodeJS.Timeout | undefined;
        const infos = await Promise.race([
          q.supportedModels(),
          new Promise<never>((_, rej) => {
            deadline = setTimeout(() => rej(new Error("timeout")), 20_000);
          }),
        ]).finally(() => deadline && clearTimeout(deadline));
        const seen = new Set<string>();
        for (const m of infos) {
          const id = m.resolvedModel ?? m.value;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const info = m as unknown as { supportsEffort?: boolean; supportedEffortLevels?: string[]; displayName?: string };
          models.push({
            id,
            displayName: info.displayName,
            reasoningEfforts: info.supportsEffort === false ? [] : (info.supportedEffortLevels ?? []),
          });
        }
        await q.interrupt().catch(() => undefined);
      } catch {
        /* version-only capability report */
      }
    }
    return {
      available: true,
      version: version.stdout.trim().split("\n")[0],
      models,
      approvalModes: executor.host ? ["auto", "bypass"] : ["manual", "accept-edits", "auto", "bypass"],
      structuredOutput: true,
      sessions: true,
      detail: executor.host
        ? "claude CLI over ssh (stream-json); remote approvals limited to auto/bypass in v1"
        : "Agent SDK; model catalog via supportedModels()",
    };
  },

  invoke(req: LeafRequest, ctx: HarnessContext): AsyncIterable<HarnessEvent> {
    return req.host ? invokeRemoteCli(req, ctx) : invokeSdk(req, ctx);
  },
};

// ---------------------------------------------------------------------------
// Local transport: Agent SDK
// ---------------------------------------------------------------------------
async function* invokeSdk(req: LeafRequest, ctx: HarnessContext): AsyncIterable<HarnessEvent> {
  const abort = new AbortController();
  const onAbort = () => abort.abort(ctx.signal.reason as Error | undefined);
  if (ctx.signal.aborted) onAbort();
  ctx.signal.addEventListener("abort", onAbort);

  const bridgeApprovals = req.approvalMode === "manual" || req.approvalMode === "accept-edits";
  // Sandbox confines a WRITE leaf's file edits to cwd + sandboxDirs. Read-only
  // leaves already deny write tools, so sandbox only applies to write leaves.
  const sandboxWrites = req.sandbox === true && !req.readOnly;
  const allowedRoots = [req.cwd, ...(req.sandboxDirs ?? [])];
  const permissionMode: PermissionMode =
    req.approvalMode === "manual"
      ? "default"
      : req.approvalMode === "accept-edits"
        ? "acceptEdits"
        : req.approvalMode === "bypass"
          ? "bypassPermissions"
          : "dontAsk";

  // Compose a permission callback when we need to bridge approvals AND/OR
  // enforce the write sandbox. Path-check first (deny out-of-sandbox writes),
  // then bridge to the operator if the mode asks.
  const needsCallback = bridgeApprovals || sandboxWrites;
  const canUseTool = needsCallback
    ? async (toolName: string, input: Record<string, unknown>) => {
        if (sandboxWrites && WRITE_TOOLS.includes(toolName)) {
          const target = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
          if (target && !pathWithin(target, allowedRoots)) {
            return {
              behavior: "deny" as const,
              message: `sandbox: ${toolName} to ${target} is outside the allowed roots (${allowedRoots.join(", ")})`,
            };
          }
        }
        if (!bridgeApprovals) return { behavior: "allow" as const, updatedInput: input };
        const decision = await ctx.requestApproval({ runId: req.runId, seq: req.seq, toolName, input: input as Json });
        return decision.behavior === "allow"
          ? { behavior: "allow" as const, updatedInput: input }
          : { behavior: "deny" as const, message: decision.message ?? "denied by operator" };
      }
    : undefined;

  const claudePath = systemClaudePath();
  const options: Options = {
    cwd: req.cwd,
    model: req.model,
    effort: req.reasoningEffort as Options["effort"],
    resume: req.sessionId,
    abortController: abort,
    permissionMode,
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    // Explicit on purpose: the omitted-default changed across SDK versions.
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code", append: req.system },
    maxTurns: 100,
    ...(req.approvalMode === "bypass" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(req.readOnly ? { disallowedTools: WRITE_TOOLS } : {}),
    ...(req.schema ? { outputFormat: { type: "json_schema", schema: req.schema as Record<string, unknown> } } : {}),
    ...(canUseTool ? { canUseTool } : {}),
  };

  // Announce the requested model/effort immediately so the monitor shows them
  // from the first frame; refine `model` to the SDK's resolved id when it arrives.
  yield { kind: "model", model: req.model, reasoningEffort: req.reasoningEffort };
  let reportedModel = req.model;
  try {
    for await (const message of query({ prompt: req.prompt, options })) {
      const m =
        (message as { message?: { model?: string } }).message?.model ??
        (message as { model?: string }).model;
      if (m && m !== reportedModel) {
        reportedModel = m;
        yield { kind: "model", model: m, reasoningEffort: req.reasoningEffort };
      }
      for (const ev of mapSdkMessage(message)) yield ev;
    }
  } catch (err) {
    if (ctx.signal.aborted) {
      yield { kind: "error", message: `aborted: ${String(ctx.signal.reason ?? "cancelled")}` };
    } else {
      yield { kind: "error", message: String(err instanceof Error ? err.message : err) };
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

function* mapSdkMessage(message: SDKMessage): Iterable<HarnessEvent> {
  const now = Date.now();
  if (message.type === "system" && message.subtype === "init") {
    yield { kind: "session", sessionId: message.session_id };
  } else if (message.type === "system" && message.subtype === "permission_denied") {
    yield {
      kind: "denied",
      toolName: message.tool_name,
      reason:
        (message as unknown as { decision_reason?: string }).decision_reason ??
        (message as unknown as { decision_reason_type?: string }).decision_reason_type ??
        "denied by permission policy",
      atMs: now,
    };
  } else if (message.type === "assistant") {
    for (const block of message.message.content ?? []) {
      if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use") {
        const b = block as { id: string; name: string; input?: unknown };
        yield { kind: "tool-call-open", id: b.id, name: b.name, input: b.input as Json, atMs: now };
      }
    }
  } else if (message.type === "user") {
    const content = (message as unknown as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result") {
          const b = block as { tool_use_id: string; is_error?: boolean; content?: unknown };
          yield {
            kind: "tool-call-close",
            id: b.tool_use_id,
            status: b.is_error ? "error" : "ok",
            result: toolResultText(b.content),
            atMs: now,
          };
        }
      }
    }
  } else if (message.type === "result") {
    const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    yield {
      kind: "usage",
      tokensIn: usage?.input_tokens,
      tokensOut: usage?.output_tokens,
      costUsd: (message as { total_cost_usd?: number }).total_cost_usd,
    };
    if (message.subtype === "success") {
      const structured = (message as { structured_output?: unknown }).structured_output;
      if (structured !== undefined) {
        yield { kind: "result", output: structured as Json };
      } else {
        yield { kind: "result", output: extractJson(message.result) };
      }
    } else {
      yield { kind: "error", message: `claude leaf failed: ${message.subtype}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Remote transport: claude CLI over the executor (same stream-json protocol)
// ---------------------------------------------------------------------------
async function* invokeRemoteCli(req: LeafRequest, ctx: HarnessContext): AsyncIterable<HarnessEvent> {
  if (req.approvalMode === "manual" || req.approvalMode === "accept-edits") {
    yield {
      kind: "error",
      message:
        `approval mode "${req.approvalMode}" is not supported for remote claude leaves in v1 ` +
        `(no approval back-channel over ssh yet) — use auto or bypass, fail-closed`,
    };
    return;
  }
  const args = ["claude", "-p", "--verbose", "--output-format", "stream-json"];
  if (req.approvalMode === "bypass") {
    args.push("--permission-mode", "bypassPermissions", "--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "dontAsk");
  }
  if (req.readOnly) args.push("--disallowedTools", WRITE_TOOLS.join(","));
  if (req.model) args.push("--model", req.model);
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));

  const proc = ctx.executor.spawn(args, { cwd: req.cwd, stdin: "pipe" });
  const onAbort = () => proc.kill();
  ctx.signal.addEventListener("abort", onAbort);
  proc.stdin?.end(req.prompt);

  yield { kind: "model", model: req.model, reasoningEffort: req.reasoningEffort };
  let sawResult = false;
  try {
    for await (const line of lines(proc.stdout)) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON noise
      }
      for (const ev of mapCliLine(msg)) {
        if (ev.kind === "result") sawResult = true;
        yield ev;
      }
    }
    const code = await proc.exited;
    if (!sawResult) {
      yield { kind: "error", message: `remote claude exited with code ${code} without a result` };
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    proc.kill();
  }
}

function* mapCliLine(msg: Record<string, unknown>): Iterable<HarnessEvent> {
  const now = Date.now();
  const type = msg.type as string;
  if (type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
    yield { kind: "session", sessionId: msg.session_id };
  } else if (type === "assistant") {
    const content = (msg.message as { content?: unknown[] } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "tool_use" && b.id && b.name) {
          yield { kind: "tool-call-open", id: b.id, name: b.name, input: b.input as Json, atMs: now };
        }
      }
    }
  } else if (type === "user") {
    const content = (msg.message as { content?: unknown[] } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (b.type === "tool_result" && b.tool_use_id) {
          yield {
            kind: "tool-call-close",
            id: b.tool_use_id,
            status: b.is_error ? "error" : "ok",
            result: toolResultText(b.content),
            atMs: now,
          };
        }
      }
    }
  } else if (type === "result") {
    const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    yield {
      kind: "usage",
      tokensIn: usage?.input_tokens,
      tokensOut: usage?.output_tokens,
      costUsd: msg.total_cost_usd as number | undefined,
    };
    if (msg.subtype === "success") {
      if (msg.structured_output !== undefined) {
        yield { kind: "result", output: msg.structured_output as Json };
      } else {
        yield { kind: "result", output: extractJson(String(msg.result ?? "")) };
      }
    } else {
      yield { kind: "error", message: `claude leaf failed: ${String(msg.subtype)}` };
    }
  }
}

// ---------------------------------------------------------------------------
async function* lines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** True if `target` resolves to a path at or under one of `roots`. */
export function pathWithin(target: string, roots: string[]): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  };
  const t = norm(target);
  return roots.some((r) => {
    const root = norm(r);
    return t === root || t.startsWith(root);
  });
}

/** Normalize a tool_result content field into a bounded string for the trace. */
export function toolResultText(content: unknown): Json {
  const MAX = 8 * 1024;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return JSON.stringify(b);
      })
      .join("\n");
  } else if (content === undefined || content === null) {
    return null;
  } else {
    text = JSON.stringify(content);
  }
  return text.length > MAX ? text.slice(0, MAX) + `\n… [truncated ${text.length - MAX} chars]` : text;
}

/**
 * Best-effort: parse the final text as JSON, else scan (string-aware) for the
 * last top-level balanced {...} that parses.
 */
export function extractJson(text: string): Json {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    /* fall through */
  }
  let last: Json | undefined;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            last = JSON.parse(trimmed.slice(start, i + 1)) as Json;
          } catch {
            /* not a JSON object after all */
          }
          start = -1;
        }
      }
    }
  }
  return last ?? { text: trimmed };
}
