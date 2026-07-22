/**
 * The zod-first operation registry — the single source of truth for the CLI
 * command tree, the MCP tool schemas (passed to the MCP SDK natively), and the
 * SDK types (z.infer). No codegen step; heads interpret this at runtime.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  ProgramVM,
  acquireLock,
  appendControl,
  compileProgram,
  listRuns,
  openApprovals,
  prepareRun,
  readJournal,
  readManifest,
  readResult,
  readTraces,
  runPaths,
  sourceRequestsWrite,
  statusForRun,
  superviseRun,
  type HarnessCapabilities,
  type Json,
  type Registry,
  type RunStatus,
  type ThunkSpec,
} from "@karowanorg/orc-core";
import { MonitorServer, openInBrowser, portForHome, writeReport } from "@karowanorg/orc-ui";
import { orcHome } from "@karowanorg/orc-core";
import { GUIDE } from "./guide.js";

export interface OpContext {
  registry: Registry;
  registryCwd?: string;
  mcpClientName?: string;
}

export interface OpDef<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  doc: string;
  readOnly: boolean;
  input: I;
  handler(input: z.infer<I>, ctx: OpContext): Promise<O>;
}

function defineOp<I extends z.ZodType, O>(def: OpDef<I, O>): OpDef<I, O> {
  return def;
}

const ApprovalMode = z.enum(["manual", "accept-edits", "auto", "bypass"]);
const RunId = z.string().regex(/^[a-zA-Z0-9_-]+$/, "run id");

interface FirstFrontierCall {
  seq: number;
  kind: string;
  id?: string;
  readOnly: boolean;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  schema?: Json;
  promptPreview?: string;
}

// ---------------------------------------------------------------------------
export const launch = defineOp({
  name: "launch",
  doc: "Compile, pin, and start a program as a new run. Returns immediately unless --wait.",
  readOnly: false,
  input: z.object({
    programPath: z.string().describe("path to the program (.orc.ts/.ts/.js)"),
    cwd: z.string().optional().describe("working directory (plain path); defaults to the caller's cwd"),
    brief: z.string().describe("shared context injected into every leaf"),
    allowWrites: z.boolean().default(false).describe("grant write-declared leaves permission to mutate files"),
    approvalMode: ApprovalMode.default("auto").describe("manual | accept-edits | auto | bypass"),
    sandbox: z.boolean().default(false).describe("confine write leaves to cwd + sandboxDirs (default: unconfined, like the caller)"),
    sandboxDirs: z.array(z.string()).optional().describe("extra writable roots when sandboxed (e.g. cache dirs outside the workspace)"),
    networkAccess: z.boolean().default(false).describe("permit outbound network while retaining filesystem sandboxing"),
    maxParallel: z.number().int().min(1).max(64).optional(),
    idleTimeoutSeconds: z.number().int().optional().describe("run default for the per-call output-idle watchdog; 0 disables"),
    budget: z.number().positive().optional().describe("reactive USD cap: fail the run once observed estimated cost exceeds this (may overshoot)"),
    name: z.string().optional(),
    harness: z.string().optional().describe("default harness override (else caller affinity → codex)"),
    wait: z.boolean().default(false).describe("supervise in the foreground and return the final status"),
  }),
  async handler(input, ctx) {
    const manifest = await prepareRun(
      {
        programPath: input.programPath,
        cwd: input.cwd,
        brief: input.brief,
        allowWrites: input.allowWrites,
        approvalMode: input.approvalMode,
        sandbox: input.sandbox,
        sandboxDirs: input.sandboxDirs,
        networkAccess: input.networkAccess,
        maxParallel: input.maxParallel,
        idleTimeout:
          input.idleTimeoutSeconds === undefined
            ? undefined
            : input.idleTimeoutSeconds === 0
              ? false
              : input.idleTimeoutSeconds * 1000,
        budgetUsd: input.budget,
        name: input.name,
        defaultHarness: input.harness,
      },
      ctx.registry,
    );
    const bundle = fs.readFileSync(runPaths(manifest.runId).program, "utf8");
    const requestsWrite = sourceRequestsWrite(bundle);
    writeReport(manifest.runId);
    const monitorUrl = `http://127.0.0.1:${portForHome(orcHome())}/runs/${manifest.runId}`;
    if (input.wait) {
      const status = await superviseRun(manifest.runId, ctx.registry, { onUpdate: debouncedReport() });
      return { runId: manifest.runId, requestsWrite, monitorUrl, reportPath: runPaths(manifest.runId).report, status };
    }
    await spawnDetachedSupervisor(manifest.runId, ctx.registryCwd);
    return {
      runId: manifest.runId,
      requestsWrite,
      allowWrites: manifest.allowWrites,
      approvalMode: manifest.approvalMode,
      monitorUrl,
      reportPath: runPaths(manifest.runId).report,
      wait: { op: "wait", input: { runId: manifest.runId, timeoutSeconds: 300 } },
    };
  },
});

export const validate = defineOp({
  name: "validate",
  doc: "Compile a program and preview its first frontier without starting a run.",
  readOnly: true,
  input: z.object({
    programPath: z.string(),
    allowWrites: z.boolean().default(false),
    approvalMode: ApprovalMode.default("auto").describe("check the first-frontier harnesses can honor this mode"),
    harness: z.string().optional().describe("default harness override (same precedence as launch)"),
    checkCapabilities: z.boolean().default(true).describe("probe referenced harnesses for model/effort/mode support (slower)"),
  }),
  async handler(input, ctx) {
    const { bundle, sha256 } = await compileProgram(input.programPath);
    const requestsWrite = sourceRequestsWrite(bundle);
    const firstCalls: FirstFrontierCall[] = [];
    const problems: string[] = [];
    let vm: ProgramVM | undefined;
    try {
      vm = await ProgramVM.create(bundle, DEFAULT_POLICY, {
        onCall: (seq, spec: ThunkSpec) => {
          firstCalls.push({
            seq,
            kind: spec.kind,
            id: spec.id,
            readOnly: spec.readOnly,
            harness: spec.harness,
            model: spec.model,
            reasoningEffort: spec.reasoningEffort,
            schema: spec.schema,
            promptPreview: spec.prompt?.slice(0, 120),
          });
        },
        onLog: () => undefined,
        onPhase: () => undefined,
      });
      const state = vm.state();
      if (state.state === "error") problems.push(`program failed before its first call: ${state.error}`);
      if (state.state === "ok" && firstCalls.length === 0) problems.push("program completes without dispatching any leaf");
    } catch (err) {
      problems.push(String(err instanceof Error ? err.message : err));
    } finally {
      vm?.dispose();
    }

    const capsCache = new Map<string, Promise<HarnessCapabilities>>();
    const capsFor = (harnessName: string): Promise<HarnessCapabilities> => {
      const cached = capsCache.get(harnessName);
      if (cached) return cached;
      const harness = ctx.registry.harnesses.get(harnessName);
      if (!harness) return Promise.reject(new Error(`unknown harness "${harnessName}"`));
      const pending = Promise.resolve().then(() =>
        harness.discover({ executor: ctx.registry.executor }),
      );
      capsCache.set(harnessName, pending);
      return pending;
    };

    for (const call of firstCalls) {
      if (call.kind.startsWith("ext:")) {
        const extension = ctx.registry.extensions.get(call.kind.slice(4));
        if (!extension) {
          problems.push(`call ${call.seq} uses unregistered extension ${call.kind} (register it in orc.config)`);
        } else {
          // Runtime registration is authoritative; the program cannot make a
          // write extension appear read-only.
          call.readOnly = extension.readOnly;
        }
      }
      if (!call.readOnly && !input.allowWrites) {
        problems.push(`call ${call.seq} declares readOnly:false but allowWrites was not granted (fail-closed at dispatch)`);
      }
      if (call.kind === "agent") {
        const harnessName = call.harness ?? input.harness ?? ctx.registry.defaultHarness;
        const harness = ctx.registry.harnesses.get(harnessName);
        if (!harness) {
          problems.push(`call ${call.seq} uses unknown harness "${harnessName}" (available: ${[...ctx.registry.harnesses.keys()].join(", ")})`);
        } else {
          // Static structured-output check — no live probe, so it runs even
          // with --no-check-capabilities: reject a schema the harness would
          // fail on at invocation time (e.g. codex strict mode's open maps).
          if (call.schema !== undefined && harness.lintOutputSchema) {
            for (const p of harness.lintOutputSchema(call.schema)) {
              problems.push(`call ${call.seq} output schema ${p}`);
            }
          }
        }
        if (harness && input.checkCapabilities) {
          let caps: HarnessCapabilities;
          try {
            caps = await capsFor(harnessName);
          } catch (err) {
            problems.push(
              `call ${call.seq}: could not discover harness "${harnessName}" (${String(err instanceof Error ? err.message : err)})`,
            );
            continue;
          }
          if (!caps.available) {
            problems.push(`call ${call.seq}: harness "${harnessName}" is not available (${caps.detail ?? "not found"})`);
          } else {
            if (call.schema !== undefined && !caps.structuredOutput) {
              problems.push(`call ${call.seq}: harness "${harnessName}" does not support structured output`);
            }
            const modelIds = caps.models.map((m) => m.id);
            const matched = call.model ? caps.models.find((m) => m.id === call.model) : undefined;
            if (call.model && modelIds.length > 0 && !matched) {
              problems.push(`call ${call.seq}: model "${call.model}" not in ${harnessName}'s catalog (${modelIds.slice(0, 6).join(", ")}…)`);
            }
            if (call.reasoningEffort) {
              if (matched) {
                // The model is known: its ladder is authoritative. An empty
                // ladder means the model takes no effort param at all, so any
                // effort is invalid (e.g. Haiku vs. Fable).
                if (matched.reasoningEfforts.length === 0) {
                  problems.push(`call ${call.seq}: model "${matched.id}" takes no reasoning effort (drop reasoningEffort "${call.reasoningEffort}")`);
                } else if (!matched.reasoningEfforts.includes(call.reasoningEffort)) {
                  problems.push(`call ${call.seq}: reasoning effort "${call.reasoningEffort}" not supported by model "${matched.id}" (${matched.reasoningEfforts.join(", ")})`);
                }
              } else {
                // No specific model pinned: gate against the union across the
                // catalog, but only when we actually discovered efforts.
                const union = [...new Set(caps.models.flatMap((m) => m.reasoningEfforts))];
                if (union.length > 0 && !union.includes(call.reasoningEffort)) {
                  problems.push(`call ${call.seq}: reasoning effort "${call.reasoningEffort}" not supported by ${harnessName} (${union.join(", ")})`);
                }
              }
            }
            const approvalMode = input.approvalMode ?? "auto";
            if (caps.approvalModes.length > 0 && !caps.approvalModes.includes(approvalMode)) {
              problems.push(`call ${call.seq}: harness "${harnessName}" cannot honor approval mode "${approvalMode}" (supports: ${caps.approvalModes.join(", ")})`);
            }
          }
        }
      }
    }
    return { ok: problems.length === 0, sha256, requestsWrite, firstCalls, problems };
  },
});

export const status = defineOp({
  name: "status",
  doc: "Body-free status projection for a run.",
  readOnly: true,
  input: z.object({ runId: RunId }),
  async handler(input) {
    return statusForRun(input.runId);
  },
});

export const wait = defineOp({
  name: "wait",
  doc: "Block (bounded, ≤300s) until the run settles; returns status plus a retry handoff on timeout.",
  readOnly: true,
  input: z.object({
    runId: RunId,
    timeoutSeconds: z.number().int().min(1).max(300).default(120),
  }),
  async handler(input) {
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    for (;;) {
      const s = statusForRun(input.runId);
      if (s.state !== "running") return { outcome: s.state, timedOut: false, status: s };
      if (Date.now() >= deadline) {
        return {
          outcome: "running",
          timedOut: true,
          status: s,
          retry: { op: "wait", input: { runId: input.runId, timeoutSeconds: input.timeoutSeconds } },
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
});

export const getResult = defineOp({
  name: "get-result",
  doc: "Hydrate one result body: the run's final result, or one leaf's by seq.",
  readOnly: true,
  input: z.object({
    runId: RunId,
    seq: z.number().int().optional().describe("leaf sequence number; omit for the final program result"),
  }),
  async handler(input) {
    const paths = runPaths(input.runId);
    const journal = readJournal(input.runId);
    if (input.seq === undefined) {
      const finish = [...journal].reverse().find((r) => r.t === "finish");
      if (!finish) throw new Error("run has no final result yet");
      if (finish.status !== "completed" || !finish.resultSha) {
        throw new Error(`run ${finish.status}: ${finish.error ?? "no result body"}`);
      }
      return { body: readResult(paths, finish.resultSha), sha256: finish.resultSha };
    }
    const done = [...journal]
      .reverse()
      .find((r) => r.t === "done" && r.seq === input.seq && r.status === "ok");
    if (!done || done.t !== "done" || !done.resultSha) throw new Error(`no ok completion for seq ${input.seq}`);
    return { body: readResult(paths, done.resultSha), sha256: done.resultSha };
  },
});

export const getTrace = defineOp({
  name: "trace",
  doc: "The run's trace: status projection plus bounded leaf/tool detail.",
  readOnly: true,
  input: z.object({ runId: RunId }),
  async handler(input) {
    const s = statusForRun(input.runId);
    const traces = readTraces(input.runId).map((t) => {
      if (t.t !== "leaf") return t;
      const bound = (v?: string) => (v && v.length > 16_384 ? v.slice(0, 16_384) + `…[truncated]` : v);
      return { ...t, prompt: bound(t.prompt), brief: bound(t.brief), error: bound(t.error) };
    });
    return { status: s, traces };
  },
});

export const list = defineOp({
  name: "list",
  doc: "List runs, newest first.",
  readOnly: true,
  input: z.object({ limit: z.number().int().min(1).max(200).default(25) }),
  async handler(input) {
    return listRuns()
      .slice(0, input.limit)
      .map((m) => {
        let state = "unknown";
        try {
          state = statusForRun(m.runId).state;
        } catch {
          /* partial run dir */
        }
        return { runId: m.runId, name: m.name, state, createdAtMs: m.createdAtMs, cwd: m.cwd };
      });
  },
});

export const cancel = defineOp({
  name: "cancel",
  doc: "Queue cancellation. Leaves get TERM→KILL on their whole process group.",
  readOnly: false,
  input: z.object({ runId: RunId }),
  async handler(input) {
    requireRunningRun(input.runId);
    appendControl(input.runId, { t: "cancel", atMs: Date.now() });
    return { enqueued: true };
  },
});

export const resume = defineOp({
  name: "resume",
  doc: "Resume a crashed or failed run. Write leaves re-dispatch as re-orienting attempts (never blind re-runs); fail-forward only.",
  readOnly: false,
  input: z.object({
    runId: RunId,
    wait: z.boolean().default(false),
  }),
  async handler(input, ctx) {
    readManifest(input.runId); // throws if unknown
    if (input.wait) {
      const s = await superviseRun(input.runId, ctx.registry, { onUpdate: debouncedReport() });
      return { runId: input.runId, status: s };
    }
    const current = statusForRun(input.runId);
    if (current.state === "completed") throw new Error(`run ${input.runId} already completed`);
    const lock = await acquireLock(runPaths(input.runId));
    await lock.release();
    // tradeoff: releasing before spawn leaves a small ownership race; an
    // atomic handoff needs a supervisor protocol rather than this one-shot CLI.
    await spawnDetachedSupervisor(input.runId, ctx.registryCwd);
    return { runId: input.runId, resumed: true };
  },
});

export const listApprovals = defineOp({
  name: "approvals",
  doc: "List pending approval requests across a run.",
  readOnly: true,
  input: z.object({ runId: RunId }),
  async handler(input) {
    return openApprovals(readTraces(input.runId));
  },
});

export const respondApproval = defineOp({
  name: "respond",
  doc: "Queue an answer for a pending approval request.",
  readOnly: false,
  input: z.object({
    runId: RunId,
    approvalId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
  }),
  async handler(input) {
    requireRunningRun(input.runId);
    if (!openApprovals(readTraces(input.runId)).some((approval) => approval.id === input.approvalId)) {
      throw new Error(`approval ${input.approvalId} is not pending for run ${input.runId}`);
    }
    appendControl(input.runId, {
      t: "approval",
      approvalId: input.approvalId,
      decision: { behavior: input.behavior, message: input.message },
      by: "operator",
      atMs: Date.now(),
    });
    return { enqueued: true };
  },
});

export const capabilities = defineOp({
  name: "capabilities",
  doc: "List harnesses, models, and reasoning levels — each discovered through the harness's native mechanism.",
  readOnly: true,
  input: z.object({
    refresh: z.boolean().default(false),
  }),
  async handler(input, ctx) {
    const executor = ctx.registry.executor;
    const out: Record<string, unknown> = {};
    for (const [name, harness] of ctx.registry.harnesses) {
      out[name] = await harness.discover({ executor }).catch((err: unknown) => ({
        available: false,
        detail: String(err instanceof Error ? err.message : err),
      }));
    }
    return {
      defaultHarness: ctx.registry.defaultHarness,
      harnesses: out,
      extensions: [...ctx.registry.extensions.keys()],
    };
  },
});

export const openMonitor = defineOp({
  name: "open",
  doc: "Ensure the monitor UI server is up and return the live URL for a run.",
  readOnly: true,
  input: z.object({
    runId: RunId.optional(),
    browser: z.boolean().default(false).describe("also open the URL in the default browser"),
  }),
  async handler(input) {
    const url = await ensureMonitor(input.runId);
    if (input.browser) openInBrowser(url);
    return { url };
  },
});

export const report = defineOp({
  name: "report",
  doc: "Write (or refresh) the self-contained report.html for a run and return its path.",
  readOnly: true,
  input: z.object({ runId: RunId }),
  async handler(input) {
    return { path: writeReport(input.runId) };
  },
});

export const guide = defineOp({
  name: "guide",
  doc: "How to write and run an orc program — the authoring + usage guide, with this machine's live harness/model catalog appended.",
  readOnly: true,
  input: z.object({
    probe: z.boolean().default(true).describe("append the live capability catalog (set false for the static doc only)"),
  }),
  async handler(input, ctx) {
    if (!input.probe) return { guide: GUIDE };
    // Bake step-2 (capability discovery) into the guide response so a model
    // goes straight from `guide` to writing, with valid harness/model/effort
    // values in hand instead of guessing. Never let a slow or missing harness
    // break the guide — degrade to the static doc, which already points at
    // `orc capabilities`.
    const caps = await withDeadline(
      capabilities.handler({ refresh: false }, ctx),
      15_000,
    ).catch(() => null);
    return { guide: GUIDE + (caps ? renderCapabilitiesForGuide(caps) : "") };
  },
});

/** Race a promise against a deadline; reject if it doesn't settle in time. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("capability probe timed out")), ms);
    }),
  ]);
}

interface GuideCaps {
  defaultHarness: string;
  harnesses: Record<string, HarnessCapabilities & { detail?: string }>;
}

/** Compact, model-readable rendering of the live catalog appended to the guide. */
function renderCapabilitiesForGuide(caps: unknown): string {
  const c = caps as GuideCaps;
  const lines: string[] = [
    "",
    "",
    "## Available on this machine",
    "",
    "Discovered live — these are the valid \`harness\`, \`model\`, and",
    `\`reasoningEffort\` values right now, so you don't have to guess. Default harness: **${c.defaultHarness}**.`,
    "Omit any of them to take the default.",
  ];
  for (const [name, h] of Object.entries(c.harnesses ?? {})) {
    if (!h?.available) {
      lines.push("", `- **${name}** — unavailable (${h?.detail ?? "not found"})`);
      continue;
    }
    lines.push("", `- **${name}**${h.version ? ` v${h.version}` : ""}`);
    for (const m of h.models ?? []) {
      const efforts =
        m.reasoningEfforts.length > 0
          ? `reasoningEffort: ${m.reasoningEfforts.join(", ")}`
          : "no reasoningEffort";
      lines.push(`    - \`${m.id}\`${m.default ? " (default)" : ""} — ${efforts}`);
    }
    if (h.approvalModes?.length) lines.push(`    - approval modes: ${h.approvalModes.join(", ")}`);
  }
  lines.push("", "Re-run `orc capabilities` any time.");
  return lines.join("\n");
}

export const doctor = defineOp({
  name: "doctor",
  doc: "Preflight this machine: harness binaries, versions, cwd existence.",
  readOnly: true,
  input: z.object({
    cwd: z.string().optional(),
  }),
  async handler(input, ctx) {
    const executor = ctx.registry.executor;
    const checks: Record<string, unknown> = {};
    for (const [name, harness] of ctx.registry.harnesses) {
      const caps = await harness.discover({ executor }).catch(() => null);
      checks[name] = caps ? { available: caps.available, version: caps.version, detail: caps.detail } : { available: false };
    }
    if (input.cwd) {
      checks.cwd = { path: input.cwd, exists: await executor.exists(input.cwd) };
    }
    return { checks };
  },
});

// ---------------------------------------------------------------------------
export const ALL_OPS: OpDef[] = [
  guide,
  launch,
  validate,
  status,
  wait,
  getResult,
  getTrace,
  list,
  cancel,
  resume,
  listApprovals,
  respondApproval,
  capabilities,
  openMonitor,
  report,
  doctor,
] as unknown as OpDef[];

/** Machine-readable catalog for `orc commands --json` and agent discovery. */
export function catalog(): Json {
  return ALL_OPS.map((op) => ({
    name: op.name,
    doc: op.doc,
    readOnly: op.readOnly,
    inputSchema: z.toJSONSchema(op.input) as Json,
  })) as Json;
}

// ---------------------------------------------------------------------------
function debouncedReport(): (runId: string) => void {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  return (runId: string) => {
    const now = Date.now();
    if (now - last > 1000) {
      last = now;
      try {
        writeReport(runId);
      } catch {
        /* best-effort */
      }
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        try {
          writeReport(runId);
        } catch {
          /* best-effort */
        }
      }, 1200);
      timer.unref();
    }
  };
}

function requireRunningRun(runId: string): RunStatus {
  const current = statusForRun(runId);
  if (current.state !== "running") throw new Error(`run ${runId} is ${current.state}, not running`);
  return current;
}

function detachedSupervisorArgs(runId: string): string[] {
  const owner = fileURLToPath(import.meta.url);
  const basename = path.basename(owner);
  if (basename === "ops.ts") {
    return ["--import", "tsx", fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url)), runId];
  }
  if (basename === "ops.js") {
    return [fileURLToPath(new URL("./supervisor-entry.js", import.meta.url)), runId];
  }
  if (basename === "orc.mjs") return [owner, "_supervise", runId];
  throw new Error(`detached supervisor entry is unavailable from bundled @karowanorg/orc-ops (${basename}); keep @karowanorg/orc-ops external`);
}

/** Start the package-owned detached supervisor and wait for its startup signal. */
export async function spawnDetachedSupervisor(runId: string, registryCwd?: string): Promise<void> {
  const args = detachedSupervisorArgs(runId);
  const env = { ...process.env };
  if (registryCwd === undefined) delete env.ORC_SUPERVISOR_REGISTRY_CWD;
  else env.ORC_SUPERVISOR_REGISTRY_CWD = registryCwd;
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("detached supervisor did not start within 10 seconds")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const finish = (err?: Error) => {
      cleanup();
      if (err) {
        if (child.connected) child.disconnect();
        child.kill();
        child.unref();
        reject(err);
      } else {
        child.unref();
        resolve();
      }
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const startup = message as { type?: unknown; message?: unknown };
      if (startup.type === "orc-supervisor-ready") finish();
      if (startup.type === "orc-supervisor-error") {
        finish(new Error(typeof startup.message === "string" ? startup.message : "detached supervisor failed to start"));
      }
    };
    const onError = (err: Error) => finish(err);
    const onExit = (code: number | null) => finish(new Error(`detached supervisor exited during startup (code ${code ?? "signal"})`));
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

let monitorSingleton: MonitorServer | null = null;
async function ensureMonitor(runId?: string): Promise<string> {
  const home = orcHome();
  const firstPort = portForHome(home);
  let base: string | undefined;
  for (let offset = 0; offset <= 20; offset++) {
    const candidate = `http://127.0.0.1:${firstPort + offset}`;
    const health = await fetch(`${candidate}/health.json`, { signal: AbortSignal.timeout(500) })
      .then(async (response) => response.ok ? await response.json() as { service?: unknown; home?: unknown } : undefined)
      .catch(() => undefined);
    if (health?.service === "orc-monitor" && health.home === home) {
      base = candidate;
      break;
    }
  }
  if (!base) {
    monitorSingleton ??= new MonitorServer();
    base = (await monitorSingleton.start()).url;
  }
  return runId ? `${base}/runs/${runId}` : base;
}
