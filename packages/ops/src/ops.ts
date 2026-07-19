/**
 * The zod-first operation registry — the single source of truth for the CLI
 * command tree, the MCP tool schemas (passed to the MCP SDK natively), and the
 * SDK types (z.infer). No codegen step; heads interpret this at runtime.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  ProgramVM,
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
} from "@orc/core";
import { MonitorServer, openInBrowser, portForHome, writeReport } from "@orc/ui";
import { orcHome } from "@orc/core";
import { GUIDE } from "./guide.js";

export interface OpContext {
  registry: Registry;
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
    host: z.string().optional().describe("SSH destination (separate field; e.g. 'build@ci-box' or an ssh-config alias)"),
    brief: z.string().describe("shared context injected into every leaf"),
    allowWrites: z.boolean().default(false).describe("grant write-declared leaves permission to mutate files"),
    approvalMode: ApprovalMode.default("auto").describe("manual | accept-edits | auto | bypass"),
    sandbox: z.boolean().default(false).describe("confine write leaves to cwd + sandboxDirs (default: unconfined, like the caller)"),
    sandboxDirs: z.array(z.string()).optional().describe("extra writable roots when sandboxed (e.g. cache dirs outside the workspace)"),
    maxParallel: z.number().int().min(1).max(64).optional(),
    idleTimeoutSeconds: z.number().int().optional().describe("run default for the per-call output-idle watchdog; 0 disables"),
    budget: z.number().positive().optional().describe("USD cap: cancel the run once its estimated cost exceeds this"),
    name: z.string().optional(),
    harness: z.string().optional().describe("default harness override (else caller affinity → codex)"),
    wait: z.boolean().default(false).describe("supervise in the foreground and return the final status"),
  }),
  async handler(input, ctx) {
    const manifest = await prepareRun(
      {
        programPath: input.programPath,
        cwd: input.cwd,
        host: input.host,
        brief: input.brief,
        allowWrites: input.allowWrites,
        approvalMode: input.approvalMode,
        sandbox: input.sandbox,
        sandboxDirs: input.sandboxDirs,
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
    spawnDetachedSupervisor(manifest.runId);
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
    approvalMode: z.enum(["manual", "accept-edits", "auto", "bypass"]).optional().describe("check the first-frontier harnesses can honor this mode"),
    host: z.string().optional().describe("check capabilities on this remote host"),
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

    // Cache capability probes per harness so we discover each at most once.
    const capsCache = new Map<string, HarnessCapabilities | null>();
    const capsFor = async (harnessName: string): Promise<HarnessCapabilities | null> => {
      if (capsCache.has(harnessName)) return capsCache.get(harnessName)!;
      const harness = ctx.registry.harnesses.get(harnessName);
      if (!harness) return null;
      const caps = await harness
        .discover({ executor: ctx.registry.executorFor(input.host) })
        .catch(() => null);
      capsCache.set(harnessName, caps);
      return caps;
    };

    for (const call of firstCalls) {
      if (!call.readOnly && !input.allowWrites) {
        problems.push(`call ${call.seq} declares readOnly:false but allowWrites was not granted (fail-closed at dispatch)`);
      }
      if (call.kind.startsWith("ext:") && !ctx.registry.extensions.has(call.kind.slice(4))) {
        problems.push(`call ${call.seq} uses unregistered extension ${call.kind} (register it in orc.config)`);
      }
      if (call.kind === "agent") {
        const harnessName = call.harness ?? ctx.registry.defaultHarness;
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
          const caps = await capsFor(harnessName);
          if (caps && !caps.available) {
            problems.push(`call ${call.seq}: harness "${harnessName}" is not available (${caps.detail ?? "not found"})`);
          } else if (caps) {
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
            if (input.approvalMode && caps.approvalModes.length > 0 && !caps.approvalModes.includes(input.approvalMode)) {
              problems.push(`call ${call.seq}: harness "${harnessName}" cannot honor approval mode "${input.approvalMode}"${input.host ? " over ssh" : ""} (supports: ${caps.approvalModes.join(", ")})`);
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
        return { runId: m.runId, name: m.name, state, createdAtMs: m.createdAtMs, host: m.host, cwd: m.cwd };
      });
  },
});

export const cancel = defineOp({
  name: "cancel",
  doc: "Cancel a running run (SIGTERM-grace-SIGKILL for its leaves).",
  readOnly: false,
  input: z.object({ runId: RunId }),
  async handler(input) {
    appendControl(input.runId, { t: "cancel", atMs: Date.now() });
    return { ok: true };
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
    spawnDetachedSupervisor(input.runId);
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
  doc: "Answer a pending approval request.",
  readOnly: false,
  input: z.object({
    runId: RunId,
    approvalId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
  }),
  async handler(input) {
    appendControl(input.runId, {
      t: "approval",
      approvalId: input.approvalId,
      decision: { behavior: input.behavior, message: input.message },
      by: "operator",
      atMs: Date.now(),
    });
    return { ok: true };
  },
});

export const capabilities = defineOp({
  name: "capabilities",
  doc: "List harnesses, models, and reasoning levels — each discovered through the harness's native mechanism.",
  readOnly: true,
  input: z.object({
    host: z.string().optional().describe("probe a remote host instead of local"),
    refresh: z.boolean().default(false),
  }),
  async handler(input, ctx) {
    const executor = ctx.registry.executorFor(input.host);
    const out: Record<string, unknown> = {};
    for (const [name, harness] of ctx.registry.harnesses) {
      out[name] = await harness.discover({ executor }).catch((err: unknown) => ({
        available: false,
        detail: String(err instanceof Error ? err.message : err),
      }));
    }
    return {
      host: input.host ?? "(local)",
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
    host: z.string().optional().describe("probe this remote host's harnesses instead of local"),
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
      capabilities.handler({ host: input.host, refresh: false }, ctx),
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
  host: string;
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
    `Discovered live${c.host && c.host !== "(local)" ? ` on ${c.host}` : ""} — these are the valid \`harness\`, \`model\`, and`,
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
  lines.push("", "Re-run `orc capabilities` any time, or `orc capabilities --host <ssh>` for another machine.");
  return lines.join("\n");
}

export const doctor = defineOp({
  name: "doctor",
  doc: "Preflight an executor: harness binaries, versions, cwd existence.",
  readOnly: true,
  input: z.object({
    host: z.string().optional(),
    cwd: z.string().optional(),
  }),
  async handler(input, ctx) {
    const executor = ctx.registry.executorFor(input.host);
    const checks: Record<string, unknown> = {};
    for (const [name, harness] of ctx.registry.harnesses) {
      const caps = await harness.discover({ executor }).catch(() => null);
      checks[name] = caps ? { available: caps.available, version: caps.version, detail: caps.detail } : { available: false };
    }
    if (input.cwd) {
      checks.cwd = { path: input.cwd, exists: await executor.exists(input.cwd) };
    }
    return { host: input.host ?? "(local)", checks };
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

/**
 * Detached supervisor child: re-invokes THIS entrypoint with `_supervise <id>`.
 * Works in both dev (tsx-loaded .ts entry) and a bundled/global install (.mjs).
 * ORC_CLI_ENTRY lets a wrapper pin the entry explicitly.
 */
export function spawnDetachedSupervisor(runId: string): void {
  const entry = process.env.ORC_CLI_ENTRY ?? process.argv[1] ?? "";
  const needsTsx = entry.endsWith(".ts");
  const args = needsTsx ? ["--import", "tsx", entry, "_supervise", runId] : [entry, "_supervise", runId];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

let monitorSingleton: MonitorServer | null = null;
async function ensureMonitor(runId?: string): Promise<string> {
  const port = portForHome(orcHome());
  const base = `http://127.0.0.1:${port}`;
  // Is one already serving (this process or another)?
  const alive = await fetch(`${base}/`, { signal: AbortSignal.timeout(500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!alive) {
    monitorSingleton ??= new MonitorServer();
    await monitorSingleton.start();
  }
  return runId ? `${base}/runs/${runId}` : base;
}
