import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Executor,
  HarnessContext,
  HarnessEvent,
  LeafRequest,
  SpawnOptions,
} from "@karowanorg/orc-core";
import { LocalExecutor } from "@karowanorg/orc-executors";
import { createCodexHarness } from "../src/harness.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-app-server.mjs",
);
const local = new LocalExecutor();

interface RunResult {
  events: HarnessEvent[];
  record: Array<Record<string, unknown>>;
  approvals: Array<Omit<ApprovalRequest, "id" | "requestedAtMs">>;
  logs: string[];
  cwd: string;
}

function makeReq(
  cwd: string,
  overrides: Partial<LeafRequest> = {},
): LeafRequest {
  return {
    runId: "run-1",
    seq: 1,
    prompt: "do the thing",
    system: "you are a test leaf",
    brief: "orc harness test",
    readOnly: true,
    cwd,
    approvalMode: "auto",
    ...overrides,
  };
}

async function runScenario(
  scenario: string,
  reqOverrides: Partial<LeafRequest> = {},
  opts: {
    decision?: ApprovalDecision;
    approvalDelayMs?: number;
    signal?: AbortSignal;
    onEvent?: (ev: HarnessEvent, ctx: { abort: () => void }) => void;
  } = {},
): Promise<RunResult> {
  const dir = await fs.mkdtemp(join(tmpdir(), "orc-codex-"));
  const recordPath = join(dir, "record.jsonl");
  const cwd = join(dir, "cwd");
  await fs.mkdir(cwd);
  const harness = createCodexHarness({
    appServerCommand: ["node", FIXTURE, scenario, recordPath],
    interruptGraceMs: 500,
  });
  const approvals: RunResult["approvals"] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const ctx: HarnessContext = {
    executor: local,
    reportActivity: () => undefined,
    requestApproval: async (req) => {
      approvals.push(req);
      if (opts.approvalDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, opts.approvalDelayMs),
        );
      }
      return opts.decision ?? { behavior: "allow" };
    },
    signal: opts.signal ?? controller.signal,
    log: (m) => logs.push(m),
  };
  const events: HarnessEvent[] = [];
  for await (const ev of harness.invoke(makeReq(cwd, reqOverrides), ctx)) {
    events.push(ev);
    opts.onEvent?.(ev, { abort: () => controller.abort() });
  }
  const raw = await fs.readFile(recordPath, "utf8").catch(() => "");
  const record = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { events, record, approvals, logs, cwd };
}

function methodParams(
  record: RunResult["record"],
  method: string,
): Record<string, unknown> {
  const msg = record.find((m) => m.method === method);
  expect(msg, `expected recorded ${method}`).toBeDefined();
  return (msg!.params ?? {}) as Record<string, unknown>;
}

function approvalResponse(
  record: RunResult["record"],
): Record<string, unknown> {
  const note = record.find((m) => m.note === "approval-response");
  expect(note, "expected recorded approval response").toBeDefined();
  return (note!.response ?? {}) as Record<string, unknown>;
}

describe("codexHarness happy path", () => {
  it("emits session, tool calls, text, usage, and parsed structured result in order", async () => {
    const schema = {
      type: "object",
      required: ["ok", "n"],
      properties: { ok: { type: "boolean" }, n: { type: "number" } },
    };
    const { events, record, cwd } = await runScenario("happy", {
      schema,
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      approvalMode: "auto",
      readOnly: true,
    });

    const kinds = events.map((e) => e.kind);
    // the harness announces the requested model/effort first, then the session
    expect(kinds[0]).toBe("model");
    const model = events[0] as Extract<HarnessEvent, { kind: "model" }>;
    expect(model.kind === "model" && "reasoningEffort" in model).toBe(true);
    const session = events.find((e) => e.kind === "session") as Extract<
      HarnessEvent,
      { kind: "session" }
    >;
    expect(session.sessionId).toBe("thread-fake-1");
    expect(kinds.indexOf("model")).toBeLessThan(kinds.indexOf("session"));

    expect(kinds).toContain("tool-call-open");
    expect(kinds).toContain("tool-call-close");
    expect(kinds.indexOf("tool-call-open")).toBeLessThan(
      kinds.indexOf("tool-call-close"),
    );
    const open = events.find((e) => e.kind === "tool-call-open")!;
    expect(open.kind === "tool-call-open" && open.name).toBe("command");

    const text = events
      .filter(
        (e): e is Extract<HarnessEvent, { kind: "text" }> => e.kind === "text",
      )
      .map((e) => e.delta)
      .join("");
    expect(text).toBe('{"ok":true,"n":2}');

    const usage = events.find((e) => e.kind === "usage")!;
    expect(usage.kind === "usage" && usage.tokensIn).toBe(100);
    expect(usage.kind === "usage" && usage.tokensOut).toBe(20);
    expect(usage.kind === "usage" && usage.costUsd).toBeCloseTo(0.0010225, 10);

    const result = events.at(-1)!;
    expect(result.kind).toBe("result");
    expect(result.kind === "result" && result.output).toEqual({
      ok: true,
      n: 2,
    });

    // Wire mapping assertions.
    const threadStart = methodParams(record, "thread/start");
    expect(methodParams(record, "initialize").capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
    expect(threadStart.approvalPolicy).toBe("never"); // auto -> never
    expect(threadStart.sandbox).toBe("read-only"); // readOnly -> read-only
    expect(threadStart.cwd).toBe(cwd);
    expect(threadStart.developerInstructions).toBe("you are a test leaf");

    const turnStart = methodParams(record, "turn/start");
    expect(turnStart.threadId).toBe("thread-fake-1");
    expect(turnStart.model).toBe("gpt-5.6-sol");
    expect(turnStart.effort).toBe("low");
    expect(turnStart.input).toEqual([{ type: "text", text: "do the thing" }]);
    const outputSchema = turnStart.outputSchema as Record<string, unknown>;
    expect(outputSchema.additionalProperties).toBe(false); // normalized
    expect(Object.keys(outputSchema.properties as object)).toEqual(["n", "ok"]); // sorted
  });

  it("prices the default model resolved by thread/start", async () => {
    const { events } = await runScenario("happy");
    const model = events.find((event) => event.kind === "model");
    expect(model).toEqual({
      kind: "model",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    const usage = events.find((event) => event.kind === "usage");
    expect(usage?.kind === "usage" && usage.costUsd).toBeCloseTo(0.0010225, 10);
  });

  it("prices an explicit Bedrock model instead of the thread default", async () => {
    const { events } = await runScenario("happy", {
      model: "openai.gpt-5.6-sol",
    });
    const model = events.find((event) => event.kind === "model");
    expect(model?.kind === "model" && model.model).toBe(
      "openai.gpt-5.6-sol",
    );
    const usage = events.find((event) => event.kind === "usage");
    expect(usage?.kind === "usage" && usage.costUsd).toBeCloseTo(
      0.00112475,
      10,
    );
  });

  it("deduplicates identical usage and accumulates distinct requests", async () => {
    const { events } = await runScenario("usage-multiple");
    const usages = events.filter(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ tokensIn: 100, tokensOut: 20 });
    expect(usages[1]).toMatchObject({ tokensIn: 250, tokensOut: 50 });
    expect(usages[1].costUsd).toBeCloseTo(0.00255, 10);
  });

  it("invalidates an earlier estimate when later request usage cannot be priced", async () => {
    const { events } = await runScenario("usage-unavailable");
    const usages = events.filter(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({
      tokensIn: 100,
      tokensOut: 20,
      costEstimated: true,
    });
    expect(usages[0].costUsd).toBeCloseTo(0.0010225, 10);
    expect(usages[1]).toEqual({ kind: "usage", costUsd: null });
  });

  it("prices only request-local usage when resuming a thread", async () => {
    const { events } = await runScenario("resume-usage", {
      sessionId: "thread-old-7",
    });
    const usage = events.find(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usage).toMatchObject({ tokensIn: 100, tokensOut: 20 });
    expect(usage?.costUsd).toBeCloseTo(0.0010225, 10);
  });

  it("marks cost unavailable when the resolved model has no exact price", async () => {
    const { events } = await runScenario("unknown-model");
    const usage = events.find(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usage).toMatchObject({ tokensIn: 100, tokensOut: 20 });
    expect(usage?.costUsd).toBeNull();
  });

  it("applies the resolved Fast/Priority service tier", async () => {
    const { events } = await runScenario("fast-tier");
    const usage = events.find(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usage?.costUsd).toBeCloseTo(0.000818, 10);
  });

  it("filesystem policy is orthogonal to approval mode", async () => {
    // approval policy comes from the mode...
    const bypass = await runScenario("happy", {
      approvalMode: "bypass",
      readOnly: false,
    });
    expect(methodParams(bypass.record, "thread/start").approvalPolicy).toBe(
      "never",
    );
    const manual = await runScenario("happy", {
      approvalMode: "manual",
      readOnly: false,
    });
    expect(methodParams(manual.record, "thread/start").approvalPolicy).toBe(
      "on-request",
    );

    // ...but sandbox comes from readOnly + the sandbox flag, NOT the mode.
    // A default write leaf OMITS the sandbox param → inherits the user's codex
    // config (never more power than the caller).
    expect(methodParams(manual.record, "thread/start").sandbox).toBeUndefined();
    // read-only leaf -> read-only sandbox
    const ro = await runScenario("happy", {
      approvalMode: "auto",
      readOnly: true,
    });
    expect(methodParams(ro.record, "thread/start").sandbox).toBe("read-only");
    // opt-in sandbox -> workspace-write (explicit confinement)
    const sb = await runScenario("happy", {
      approvalMode: "auto",
      readOnly: false,
      sandbox: true,
      sandboxDirs: ["/opt/orc-cache"],
    });
    const sbStart = methodParams(sb.record, "thread/start");
    expect(sbStart.sandbox).toBe("workspace-write");
    expect(sbStart.runtimeWorkspaceRoots).toEqual([sb.cwd, "/opt/orc-cache"]);
    // Sandboxed write leaves carry an EXPLICIT network setting both ways;
    // omission would inherit the user's config default.
    expect(sbStart.config).toEqual({
      sandbox_workspace_write: { network_access: false },
    });
    const online = await runScenario("happy", {
      approvalMode: "auto",
      readOnly: false,
      sandbox: true,
      networkAccess: true,
    });
    expect(methodParams(online.record, "thread/start").config).toEqual({
      sandbox_workspace_write: { network_access: true },
    });
    // explicit bypass -> danger-full-access (opt-in max)
    expect(methodParams(bypass.record, "thread/start").sandbox).toBe(
      "danger-full-access",
    );
  });

  it("network config is explicit for sandboxed write leaves and absent for read-only leaves", async () => {
    // A granted-but-narrowed write leaf sends an explicit false override.
    const offline = await runScenario("happy", {
      approvalMode: "auto",
      readOnly: false,
      sandbox: true,
      networkAccess: false,
    });
    expect(methodParams(offline.record, "thread/start").config).toEqual({
      sandbox_workspace_write: { network_access: false },
    });
    // Read-only leaves never carry network config, whatever the request says.
    const ro = await runScenario("happy", {
      approvalMode: "auto",
      readOnly: true,
      sandbox: true,
      networkAccess: true,
    });
    expect(methodParams(ro.record, "thread/start").config).toBeUndefined();
    // The resume site applies the same override.
    const resumed = await runScenario("happy", {
      sessionId: "thread-old-7",
      readOnly: false,
      sandbox: true,
      networkAccess: false,
    });
    expect(methodParams(resumed.record, "thread/resume").config).toEqual({
      sandbox_workspace_write: { network_access: false },
    });
  });

  it("returns {text} when no schema is set", async () => {
    const { events } = await runScenario("happy", { schema: undefined });
    const result = events.at(-1)!;
    expect(result.kind === "result" && result.output).toEqual({
      text: '{"ok":true,"n":2}',
    });
  });

  it("removes strict-schema null placeholders before returning user output", async () => {
    const schema = {
      type: "object",
      required: ["name", "nested", "rows", "choice", "variant"],
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
        nullable: { type: ["string", "null"] },
        nested: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { tag: { type: "string" } },
          },
        },
        choice: {
          anyOf: [
            { type: "object", properties: { note: { type: "string" } } },
            {
              type: "object",
              required: ["code"],
              properties: { code: { type: "number" } },
            },
          ],
        },
        variant: {
          oneOf: [
            { type: "object", properties: { label: { type: "string" } } },
            {
              type: "object",
              required: ["count"],
              properties: { count: { type: "number" } },
            },
          ],
        },
      },
    };
    const { events } = await runScenario("optional-null", { schema });
    const result = events.at(-1)!;
    expect(result.kind === "result" && result.output).toEqual({
      name: "ok",
      nullable: null,
      nested: {},
      rows: [{}],
      choice: {},
      variant: {},
    });
  });

  it("resumes a session via thread/resume", async () => {
    const { events, record, cwd } = await runScenario("happy", {
      sessionId: "thread-old-7",
      readOnly: false,
      sandbox: true,
      sandboxDirs: ["../cache"],
    });
    expect(record.some((m) => m.method === "thread/start")).toBe(false);
    const resume = methodParams(record, "thread/resume");
    expect(resume.threadId).toBe("thread-old-7");
    expect(resume.runtimeWorkspaceRoots).toEqual([cwd, join(cwd, "../cache")]);
    const session = events.find((e) => e.kind === "session")!;
    expect(session.kind === "session" && session.sessionId).toBe(
      "thread-old-7",
    );
  });
});

describe("codexHarness approval bridging", () => {
  it("bridges exec approvals to ctx.requestApproval and forwards accept", async () => {
    const { approvals, record, events } = await runScenario(
      "approval",
      { approvalMode: "manual", readOnly: false },
      { decision: { behavior: "allow" } },
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].toolName).toBe("command");
    expect(approvals[0].runId).toBe("run-1");
    expect(approvals[0].seq).toBe(1);
    expect(JSON.stringify(approvals[0].input)).toContain("touch marker.txt");
    expect(approvalResponse(record)).toEqual({ decision: "accept" });
    expect(events.some((e) => e.kind === "denied")).toBe(false);
  });

  it("forwards deny as decline and emits a denied event", async () => {
    const { record, events } = await runScenario(
      "approval",
      { approvalMode: "manual", readOnly: false },
      { decision: { behavior: "deny", message: "not on my watch" } },
    );
    expect(approvalResponse(record)).toEqual({ decision: "decline" });
    const denied = events.find((e) => e.kind === "denied")!;
    expect(denied.kind === "denied" && denied.reason).toBe("not on my watch");
  });

  it("suspends the output-idle watchdog while operator approval is pending", async () => {
    const { record, events } = await runScenario(
      "approval",
      // The watchdog arms at spawn, so the idle window must comfortably cover
      // node's interpreter boot (~50-100ms) before the fixture's first byte;
      // what matters is only that the approval delay far exceeds the window.
      { approvalMode: "manual", readOnly: false, idleTimeoutMs: 400 },
      {
        approvalDelayMs: 900,
        decision: { behavior: "allow" },
      },
    );

    expect(approvalResponse(record)).toEqual({ decision: "accept" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.at(-1)?.kind).toBe("result");
  });

  it("answers the legacy execCommandApproval family with approved/denied", async () => {
    const allow = await runScenario(
      "legacy-approval",
      { approvalMode: "manual", readOnly: false },
      { decision: { behavior: "allow" } },
    );
    expect(approvalResponse(allow.record)).toEqual({ decision: "approved" });

    const deny = await runScenario(
      "legacy-approval",
      { approvalMode: "manual", readOnly: false },
      { decision: { behavior: "deny" } },
    );
    expect(approvalResponse(deny.record)).toEqual({ decision: "denied" });
  });

  it("denies current and legacy command approvals for read-only leaves", async () => {
    const current = await runScenario(
      "approval",
      { approvalMode: "bypass", readOnly: true },
      { decision: { behavior: "allow" } },
    );
    expect(current.approvals).toHaveLength(0);
    expect(approvalResponse(current.record)).toEqual({ decision: "decline" });

    const legacy = await runScenario(
      "legacy-approval",
      { approvalMode: "manual", readOnly: true },
      { decision: { behavior: "allow" } },
    );
    expect(legacy.approvals).toHaveLength(0);
    expect(approvalResponse(legacy.record)).toEqual({ decision: "denied" });
  });

  it("accept-edits auto-approves fileChange approvals confined to req.cwd", async () => {
    const { approvals, record } = await runScenario("edit-in-cwd", {
      approvalMode: "accept-edits",
      readOnly: false,
    });
    expect(approvals).toHaveLength(0); // never reached the operator
    expect(approvalResponse(record)).toEqual({ decision: "accept" });
  });

  it("accept-edits bridges fileChange approvals outside req.cwd", async () => {
    const { approvals, record } = await runScenario(
      "edit-out-cwd",
      { approvalMode: "accept-edits", readOnly: false },
      { decision: { behavior: "deny" } },
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].toolName).toBe("edit");
    expect(approvalResponse(record)).toEqual({ decision: "decline" });
  });

  it("manual mode bridges fileChange approvals even in-cwd", async () => {
    const { approvals } = await runScenario("edit-in-cwd", {
      approvalMode: "manual",
      readOnly: false,
    });
    expect(approvals).toHaveLength(1);
  });

  it("denies current and legacy file approvals for read-only leaves", async () => {
    const current = await runScenario("edit-in-cwd", {
      approvalMode: "accept-edits",
      readOnly: true,
    });
    expect(current.approvals).toHaveLength(0);
    expect(approvalResponse(current.record)).toEqual({ decision: "decline" });

    const legacy = await runScenario("legacy-edit", {
      approvalMode: "bypass",
      readOnly: true,
    });
    expect(legacy.approvals).toHaveLength(0);
    expect(approvalResponse(legacy.record)).toEqual({ decision: "denied" });
  });

  it("does not treat a lexical parent segment as confined", async () => {
    const { approvals, record } = await runScenario(
      "edit-dotdot",
      { approvalMode: "accept-edits", readOnly: false },
      { decision: { behavior: "deny" } },
    );
    expect(approvals).toHaveLength(1);
    expect(approvalResponse(record)).toEqual({ decision: "decline" });
  });
});

describe("codexHarness watchdog and cancellation", () => {
  it("keeps a quiet turn alive while app-server answers liveness probes", async () => {
    const { events, record } = await runScenario("quiet-live", {
      idleTimeoutMs: 1_000,
    });

    expect(
      record.filter((message) => message.method === "thread/read"),
    ).toHaveLength(2);
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.at(-1)).toEqual({
      kind: "result",
      output: { text: "finished after quiet work" },
    });
  });

  it("kills the server and reports an error on output-idle timeout", async () => {
    const start = Date.now();
    const { events } = await runScenario("idle", { idleTimeoutMs: 400 });
    const err = events.find((e) => e.kind === "error")!;
    expect(err.kind === "error" && err.message).toMatch(/idle timeout/);
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  it("disables the watchdog when idleTimeoutMs is false", async () => {
    const { events } = await runScenario("happy", { idleTimeoutMs: false });
    expect(events.at(-1)!.kind).toBe("result");
  });

  it("sends turn/interrupt on abort and terminates the stream", async () => {
    const { events, record } = await runScenario(
      "cancel",
      {},
      {
        onEvent: (ev, { abort }) => {
          if (ev.kind === "text") abort();
        },
      },
    );
    expect(record.some((m) => m.method === "turn/interrupt")).toBe(true);
    const err = events.find((e) => e.kind === "error")!;
    expect(err.kind === "error" && err.message).toMatch(
      /cancelled|interrupted/,
    );
  });
});

describe("codexHarness discover", () => {
  class VersionStubExecutor implements Executor {
    private readonly inner = new LocalExecutor();
    spawn(cmd: string[], opts?: SpawnOptions) {
      return this.inner.spawn(cmd, opts);
    }
    async run(cmd: string[], opts?: SpawnOptions & { timeoutMs?: number }) {
      if (cmd[0] === "codex" && cmd[1] === "--version") {
        return { code: 0, stdout: "codex-cli 0.144.5\n", stderr: "" };
      }
      return this.inner.run(cmd, opts);
    }
    exists(path: string) {
      return this.inner.exists(path);
    }
    readFile(path: string) {
      return this.inner.readFile(path);
    }
    writeFile(path: string, data: string) {
      return this.inner.writeFile(path, data);
    }
  }

  it("reports version, models, and reasoning efforts from model/list", async () => {
    const harness = createCodexHarness({
      appServerCommand: ["node", FIXTURE, "discover"],
    });
    const caps = await harness.discover({
      executor: new VersionStubExecutor(),
    });
    expect(caps.available).toBe(true);
    expect(caps.version).toBe("0.144.5");
    // Hidden filtered, default first, each model carries its own effort ladder.
    expect(caps.models).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: undefined,
        reasoningEfforts: ["low", "medium", "high"],
        default: true,
      },
      {
        id: "gpt-5.6-luna",
        displayName: undefined,
        reasoningEfforts: ["low", "xhigh"],
        default: undefined,
      },
    ]);
    expect(caps.approvalModes).toEqual([
      "manual",
      "accept-edits",
      "auto",
      "bypass",
    ]);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.sessions).toBe(true);
    expect(caps.detail).toBe("codex app-server model/list");
  });

  it("falls back to the model under CODEX_HOME", async () => {
    class ConfigHomeExecutor extends VersionStubExecutor {
      configPath: string | undefined;
      homeCommand: string[] | undefined;

      override spawn(): never {
        throw new Error("model/list unavailable");
      }
      override async run(
        cmd: string[],
        opts?: SpawnOptions & { timeoutMs?: number },
      ) {
        if (cmd[0] === "sh") {
          this.homeCommand = cmd;
          return { code: 0, stdout: "/managed/codex", stderr: "" };
        }
        return super.run(cmd, opts);
      }
      override async readFile(path: string) {
        this.configPath = path;
        return 'model = "managed-model"\n';
      }
    }

    const executor = new ConfigHomeExecutor();
    const caps = await createCodexHarness().discover({ executor });

    expect(executor.homeCommand?.[2]).toContain("CODEX_HOME");
    expect(executor.configPath).toBe("/managed/codex/config.toml");
    expect(caps.models.map((model) => model.id)).toEqual(["managed-model"]);
  });

  it("reports unavailable when the codex binary is missing", async () => {
    class NoCodexExecutor extends VersionStubExecutor {
      override async run(
        cmd: string[],
        opts?: SpawnOptions & { timeoutMs?: number },
      ) {
        if (cmd[0] === "codex")
          return { code: 127, stdout: "", stderr: "not found" };
        return super.run(cmd, opts);
      }
    }
    const harness = createCodexHarness({
      appServerCommand: ["node", FIXTURE, "discover"],
    });
    const caps = await harness.discover({ executor: new NoCodexExecutor() });
    expect(caps.available).toBe(false);
    expect(caps.models).toEqual([]);
  });
});
