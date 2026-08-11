import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { acquireLock, appendControl, readJournal, readResult, readTraces, runPaths } from "../src/rundir.js";
import { latestLeafTraces } from "../src/status.js";
import { normalizeProgramMeta } from "../src/program-meta.js";
import { validateAgainstSchema } from "../src/jsonschema.js";
import { DEFAULT_POLICY, type Harness } from "../src/contracts.js";
import { makeFakeHarness, makeRegistry } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-fixes-"));
  process.env.ORC_HOME = home;
});

async function run(program: string, registry = makeRegistry(makeFakeHarness()), extra: Record<string, unknown> = {}) {
  const manifest = await prepareRun({ programPath: FIX(program), cwd: home, brief: "b", ...extra }, registry);
  const status = await superviseRun(manifest.runId, registry);
  return { manifest, status };
}

describe("phase() concurrency correctness", () => {
  it("labels post-await calls with the right phase even across concurrent scopes", async () => {
    const { manifest, status } = await run("phase-await.orc.ts");
    expect(status.state).toBe("completed");
    const byId = new Map(status.leaves.map((l) => [l.id, l.phase]));
    // The buggy global marker would put a2/b2 in the wrong phase.
    expect(byId.get("a1")).toBe("alpha");
    expect(byId.get("a2")).toBe("alpha");
    expect(byId.get("b1")).toBe("beta");
    expect(byId.get("b2")).toBe("beta");
    void manifest;
  });

  it("phase(name) without a function is rejected (no persistent global marker)", async () => {
    const { status } = await run("phase-nofn.orc.ts");
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/phase\(name, fn\) requires a function/);
  });
});

describe("program graph metadata", () => {
  it("normalizes one successful terminal and rejects terminal scheduling", () => {
    expect(
      normalizeProgramMeta({
        graph: {
          nodes: [
            { id: "work", title: "Work" },
            {
              id: "done",
              title: "Done",
              kind: "terminal",
              terminalState: "completed",
            },
          ],
          edges: [{ from: "work", to: "done" }],
        },
      }),
    ).toEqual({
      graph: {
        nodes: [
          { id: "work", title: "Work" },
          {
            id: "done",
            title: "Done",
            kind: "terminal",
            terminalState: "completed",
          },
        ],
        edges: [{ from: "work", to: "done" }],
      },
    });

    expect(() =>
      normalizeProgramMeta({
        graph: {
          nodes: [
            {
              id: "done",
              title: "Done",
              kind: "terminal",
              terminalState: "completed",
            },
            { id: "later", title: "Later" },
          ],
          edges: [{ from: "done", to: "later" }],
        },
      }),
    ).toThrow('terminal node "done" cannot have outgoing edges');

    expect(() =>
      normalizeProgramMeta({
        graph: {
          nodes: [
            { id: "first", title: "First" },
            { id: "second", title: "Second" },
            {
              id: "done",
              title: "Done",
              kind: "terminal",
              terminalState: "completed",
            },
          ],
          edges: [
            { from: "first", to: "done" },
            { from: "second", to: "done" },
          ],
        },
      }),
    ).toThrow('terminal node "done" must have exactly one incoming edge');
  });

  it("records normalized metadata before scoped phase lifecycle events", async () => {
    const { manifest, status } = await run("graph-meta.orc.ts");
    expect(status.state).toBe("completed");
    const traces = readTraces(manifest.runId);
    const metadata = traces.find((trace) => trace.t === "program-meta");
    expect(metadata).toMatchObject({
      t: "program-meta",
      meta: {
        graph: {
          nodes: [
            { id: "plan", title: "Plan" },
            { id: "review", title: "Review", kind: "gate" },
          ],
          edges: [
            { from: "plan", to: "review" },
            { from: "review", to: "plan", kind: "loop", label: "Changes requested" },
          ],
        },
      },
    });
    const lifecycle = traces
      .filter((trace) => trace.t === "event" && trace.event.kind === "phase")
      .map((trace) => trace.t === "event" && trace.event.kind === "phase" ? trace.event : null);
    expect(lifecycle).toEqual([
      { kind: "phase", name: "plan", state: "started", scope: 1 },
      { kind: "phase", name: "plan", state: "completed", scope: 1 },
      { kind: "phase", name: "review", state: "started", scope: 2 },
      { kind: "phase", name: "review", state: "completed", scope: 2 },
    ]);
    expect(traces.indexOf(metadata!)).toBeLessThan(
      traces.findIndex((trace) => trace.t === "event" && trace.event.kind === "phase"),
    );
  });

  it("fails before dispatch when a forward cycle is not declared as a loop", async () => {
    const { status } = await run("graph-meta-invalid.orc.ts");
    expect(status.state).toBe("failed");
    expect(status.totalCalls).toBe(0);
    expect(status.error).toContain('mark each back edge with kind: "loop"');
  });
});

describe("extension inputSchema enforcement", () => {
  it("rejects a payload that violates the extension inputSchema, before executing", async () => {
    let executed = false;
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "lookup",
          {
            name: "lookup",
            readOnly: true,
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
            execute: async () => {
              executed = true;
              return { ok: true };
            },
          },
        ],
      ]),
    });
    const { status } = await run("ext-bad.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/inputSchema/);
    expect(executed).toBe(false); // fail-closed: never ran the extension
  });

  it("treats the boolean false schema as rejecting every payload", async () => {
    let executed = false;
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "lookup",
          {
            name: "lookup",
            readOnly: true,
            inputSchema: false,
            execute: async () => {
              executed = true;
              return null;
            },
          },
        ],
      ]),
    });

    const { status } = await run("ext-bad.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/inputSchema/);
    expect(executed).toBe(false);
  });
});

describe("read-only leaf retry (supervisor retry table)", () => {
  it("retries a flaky read-only leaf up to the budget, then succeeds", async () => {
    // seq 0 fails twice, succeeds on the 3rd attempt (within the default budget of 2 retries)
    const registry = makeRegistry(makeFakeHarness({ flaky: { 0: 2 } }));
    const { manifest, status } = await run("retry.orc.ts", registry);
    expect(status.state).toBe("completed");
    // trace shows 3 attempts for seq 0
    const traces = readTraces(manifest.runId);
    const attempts = new Set(traces.filter((t) => t.t === "leaf" && t.seq === 0).map((t) => (t as { attempt: number }).attempt));
    expect([...attempts].sort()).toEqual([1, 2, 3]);
    // journal records exactly one (final, successful) completion for seq 0
    const dones = readJournal(manifest.runId).filter((r) => r.t === "done" && r.seq === 0);
    expect(dones).toHaveLength(1);
    expect(dones[0].t === "done" && dones[0].status).toBe("ok");
    const starts = readJournal(manifest.runId).filter((r) => r.t === "attempt" && r.seq === 0);
    expect(starts.map((r) => r.t === "attempt" && r.attempt)).toEqual([1, 2, 3]);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const registry = makeRegistry(makeFakeHarness({ flaky: { 0: 99 } })); // never succeeds
    const { status } = await run("retry.orc.ts", registry);
    expect(status.state).toBe("failed");
  });

  it("does NOT retry write leaves (single attempt)", async () => {
    const log = path.join(home, "inv.log");
    const registry = makeRegistry(makeFakeHarness({ failSeqs: [0], invocationLog: log }));
    const { status } = await run("writegate.orc.ts", registry, { allowWrites: true });
    expect(status.state).toBe("failed");
    const runs = fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l.startsWith("0:"));
    expect(runs).toHaveLength(1); // write leaf tried exactly once
  });

  it("retries an opted-in write leaf by re-orienting against partial mutations", async () => {
    const log = path.join(home, "write-retry.log");
    const registry = makeRegistry(makeFakeHarness({ flaky: { 0: 2 }, invocationLog: log }));
    const { manifest, status } = await run("write-auto-retry.orc.ts", registry, {
      allowWrites: true,
    });

    expect(status.state).toBe("completed");
    const runs = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(runs).toHaveLength(3);
    expect(runs[0]).not.toContain("RE-ORIENT NOTE");
    expect(runs[1]).toContain("RE-ORIENT NOTE");
    expect(runs[2]).toContain("RE-ORIENT NOTE");
    const attempts = readTraces(manifest.runId)
      .filter((trace) => trace.t === "leaf" && trace.seq === 0)
      .map((trace) => trace.t === "leaf" && trace.attempt);
    expect(new Set(attempts)).toEqual(new Set([1, 2, 3]));
  });

  it("cuts off a run whose estimated cost passes the budget", async () => {
    // Each leaf reports ~$0.60; a $1.00 budget survives leaf a (0.60) and trips
    // during leaf b (1.20 > 1.00) → the run fails terminally with a budget error.
    const registry = makeRegistry(makeFakeHarness({ costPerLeafUsd: 0.6 }));
    const { manifest, status } = await run("budget-seq.orc.ts", registry, { budgetUsd: 1.0 });
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/budget exceeded: estimated cost ~\$1\.20 passed the \$1\.00 budget/);
    // The cutoff is also narrated in the feed.
    const feed = readTraces(manifest.runId).filter((t) => t.t === "event");
    expect(JSON.stringify(feed)).toContain("failing run");
  });

  it("a run under its budget completes normally", async () => {
    const registry = makeRegistry(makeFakeHarness({ costPerLeafUsd: 0.6 }));
    const { status } = await run("budget-seq.orc.ts", registry, { budgetUsd: 10 });
    expect(status.state).toBe("completed");
  });

  it("counts spend from every retry attempt toward the hard budget", async () => {
    let invocations = 0;
    const costlyFailure: Harness = {
      name: "costly",
      async discover() {
        return {
          available: true,
          models: [],
          approvalModes: ["auto"],
          structuredOutput: true,
          sessions: false,
        };
      },
      async *invoke() {
        invocations++;
        yield { kind: "usage", costUsd: 0.6, costEstimated: true };
        yield { kind: "error", message: "transient failure" };
      },
    };
    const registry = makeRegistry(costlyFailure);
    const { manifest, status } = await run("retry.orc.ts", registry, { budgetUsd: 1 });
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/budget exceeded.*\$1\.20/);
    expect(invocations).toBe(2);
    const costs = readJournal(manifest.runId).filter((r) => r.t === "cost");
    expect(costs).toHaveLength(2);
  });

  it("fails a budgeted run when observed usage becomes unpriceable", async () => {
    const partiallyPriced: Harness = {
      name: "partially-priced",
      async discover() {
        return {
          available: true,
          models: [],
          approvalModes: ["auto"],
          structuredOutput: true,
          sessions: false,
        };
      },
      async *invoke() {
        yield { kind: "usage", costUsd: 0.1, costEstimated: true };
        yield { kind: "usage", costUsd: null };
        yield { kind: "result", output: { ok: true } };
      },
    };
    const registry = makeRegistry(partiallyPriced);
    const { manifest, status } = await run("budget-seq.orc.ts", registry, {
      budgetUsd: 10,
    });

    expect(status.state).toBe("failed");
    expect(status.error).toBe(
      "budget cannot be enforced: cost estimate became unavailable",
    );
    expect(status.detail?.metrics).toMatchObject({ costUnavailable: true });
    expect(status.detail?.metrics).not.toHaveProperty("costUsd");
    const costs = readJournal(manifest.runId).filter((r) => r.t === "cost");
    expect(costs.map((record) => record.costUsd)).toEqual([0.1, null]);
  });

  it("routes harness stderr to per-leaf hlog records, never the event feed", async () => {
    const registry = makeRegistry(
      makeFakeHarness({
        harnessLogLines: [
          "ERROR failed to renew cache TTL: missing field `x`",
          "ERROR failed to renew cache TTL: missing field `x`",
          "INFO thread started",
        ],
      }),
    );
    const { manifest, status } = await run("retry.orc.ts", registry);
    expect(status.state).toBe("completed");
    const traces = readTraces(manifest.runId);
    const hlogs = traces.filter((t) => t.t === "hlog");
    expect(hlogs).toHaveLength(3);
    expect(hlogs[0]).toMatchObject({
      seq: 0,
      message: "ERROR failed to renew cache TTL: missing field `x`",
    });
    // The orchestration feed carries none of it.
    const feedLogs = traces.filter((t) => t.t === "event" && t.event.kind === "log");
    expect(
      feedLogs.some((e) => JSON.stringify(e).includes("cache TTL")),
    ).toBe(false);
  });

  it("does NOT retry a deterministic schema error (invalid_json_schema)", async () => {
    // A read-only leaf would normally get retried, but a schema rejection is
    // deterministic — retrying only wastes model calls and delays the failure.
    const log = path.join(home, "schema-inv.log");
    const registry = makeRegistry(
      makeFakeHarness({
        failSeqs: [0],
        failMessage: () => "turn failed: invalid_json_schema: additionalProperties must be false",
        invocationLog: log,
      }),
    );
    const { status } = await run("retry.orc.ts", registry);
    expect(status.state).toBe("failed");
    const runs = fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l.startsWith("0:"));
    expect(runs).toHaveLength(1); // classified non-retryable → tried exactly once
  });

  it("enforces a requested output schema even when the harness does not", async () => {
    const log = path.join(home, "runtime-schema.log");
    const registry = makeRegistry(
      makeFakeHarness({ result: () => ({ n: 1, extra: true }), invocationLog: log }),
    );
    const { status } = await run("schema-result.orc.ts", registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/result fails output schema/);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not retry a deterministically oversized read-only result", async () => {
    const log = path.join(home, "oversized-result.log");
    const registry = makeRegistry(
      makeFakeHarness({
        result: () => ({ text: "x".repeat(1_000) }),
        invocationLog: log,
      }),
    );
    const manifest = await prepareRun(
      { programPath: FIX("retry.orc.ts"), cwd: home, brief: "b" },
      registry,
    );
    const status = await superviseRun(
      manifest.runId,
      registry,
      {},
      { ...DEFAULT_POLICY, maxResultBytes: 128 },
    );

    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/result exceeds cap/);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("supervisor shutdown", () => {
  it("releases a cancelled run even when an extension ignores abort forever", async () => {
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "never",
          {
            name: "never",
            readOnly: true,
            execute: async () => {
              started();
              return new Promise<never>(() => undefined);
            },
          },
        ],
      ]),
    });
    const manifest = await prepareRun(
      { programPath: FIX("never-ext.orc.ts"), cwd: home, brief: "b" },
      registry,
    );
    const running = superviseRun(manifest.runId, registry);
    await invoked;
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    let timeout: NodeJS.Timeout | undefined;
    const status = await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("cancel did not release the supervisor")), 3_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    expect(status.state).toBe("cancelled");
    const released = await acquireLock(runPaths(manifest.runId));
    await released.release();
  });

  it("waits for a write leaf without letting a stuck read-only sibling retain the lock", async () => {
    let writeStarted!: () => void;
    let readStarted!: () => void;
    const writeInvoked = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const readInvoked = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const harness: Harness = {
      name: "writer",
      async discover() {
        return {
          available: true,
          models: [],
          approvalModes: ["auto"],
          structuredOutput: true,
          sessions: false,
        };
      },
      async *invoke(_request, context) {
        writeStarted();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("writer stopped");
      },
    };
    const registry = makeRegistry(harness, {
      extensions: new Map([
        [
          "never",
          {
            name: "never",
            readOnly: true,
            execute: async () => {
              readStarted();
              return new Promise<never>(() => undefined);
            },
          },
        ],
      ]),
    });
    const manifest = await prepareRun(
      {
        programPath: FIX("mixed-never.orc.ts"),
        cwd: home,
        brief: "b",
        allowWrites: true,
      },
      registry,
    );
    const running = superviseRun(manifest.runId, registry);
    await Promise.all([writeInvoked, readInvoked]);
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    const status = await running;
    expect(status.state).toBe("cancelled");
    const released = await acquireLock(runPaths(manifest.runId));
    await released.release();
  });

  it("settles an idle read-only extension even when it ignores abort", async () => {
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "never",
          {
            name: "never",
            readOnly: true,
            execute: async () => new Promise<never>(() => undefined),
          },
        ],
      ]),
    });
    const manifest = await prepareRun(
      {
        programPath: FIX("never-ext.orc.ts"),
        cwd: home,
        brief: "b",
        idleTimeout: 20,
      },
      registry,
    );

    const status = await superviseRun(manifest.runId, registry);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/idle timeout/);
    const released = await acquireLock(runPaths(manifest.runId));
    await released.release();
  });

  it("keeps a quiet harness leaf alive while it reports runtime activity", async () => {
    const activeHarness: Harness = {
      name: "active",
      async discover() {
        return {
          available: true,
          models: [],
          approvalModes: ["auto"],
          structuredOutput: true,
          sessions: false,
        };
      },
      async *invoke(_req, ctx) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        ctx.reportActivity();
        await new Promise((resolve) => setTimeout(resolve, 600));
        ctx.reportActivity();
        yield { kind: "result", output: { completed: true } };
      },
    };
    const registry = makeRegistry(activeHarness);
    const manifest = await prepareRun(
      {
        programPath: FIX("retry.orc.ts"),
        cwd: home,
        brief: "b",
        idleTimeout: 800,
      },
      registry,
    );

    const status = await superviseRun(manifest.runId, registry);

    expect(status.state).toBe("completed");
  });

  it("honors an extension-specific disabled idle timeout", async () => {
    const registry = makeRegistry(makeFakeHarness(), {
      extensions: new Map([
        [
          "never",
          {
            name: "never",
            readOnly: true,
            idleTimeout: false,
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 1_200));
              return { completed: true };
            },
          },
        ],
      ]),
    });
    const manifest = await prepareRun(
      {
        programPath: FIX("never-ext.orc.ts"),
        cwd: home,
        brief: "b",
        idleTimeout: 20,
      },
      registry,
    );

    const status = await superviseRun(manifest.runId, registry);

    expect(status.state).toBe("completed");
  });
});

describe("jsonschema validator", () => {
  it("validates types, required, enum, and nested items", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["a", "b"] },
      },
      required: ["name", "status"],
    };
    expect(validateAgainstSchema({ name: "x", status: "a" }, schema)).toBeNull();
    expect(validateAgainstSchema({ status: "a" }, schema)).toMatch(/required property 'name'/);
    expect(validateAgainstSchema({ name: 5, status: "a" }, schema)).toMatch(/must be string/);
    expect(validateAgainstSchema({ name: "x", status: "z" }, schema)).toMatch(/allowed values/);
    expect(validateAgainstSchema({ name: "x", status: "a", tags: ["ok", 3] }, schema)).toMatch(/tags\/1/);
  });
  it("accepts nullable unions", () => {
    expect(validateAgainstSchema(null, { type: ["string", "null"] })).toBeNull();
    expect(validateAgainstSchema("x", { type: ["string", "null"] })).toBeNull();
  });
  it("enforces additionalProperties and draft 2020-12 keywords", () => {
    expect(
      validateAgainstSchema(
        { n: 1, extra: true },
        {
          type: "object",
          properties: { n: { type: "number" } },
          additionalProperties: false,
        },
      ),
    ).toMatch(/additional properties/);
    expect(
      validateAgainstSchema(
        ["ok", 2],
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          prefixItems: [{ type: "string" }, { type: "string" }],
        },
      ),
    ).toMatch(/must be string/);
  });

  it("accepts explicit draft-07 schemas", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: false,
    };
    expect(validateAgainstSchema(["ok", 2], schema)).toBeNull();
    expect(validateAgainstSchema(["ok", "wrong"], schema)).toMatch(/must be number/);
  });

  it("allows fresh per-call schemas to reuse the same $id", () => {
    expect(validateAgainstSchema("ok", { $id: "urn:orc:test", type: "string" })).toBeNull();
    expect(validateAgainstSchema("ok", { $id: "urn:orc:test", type: "string" })).toBeNull();
  });

  it("resolves root self-references within a call schema", () => {
    const schema = {
      $id: "urn:orc:node",
      type: "object",
      properties: { child: { $ref: "urn:orc:node" } },
    };
    expect(validateAgainstSchema({ child: {} }, schema)).toBeNull();
  });
});
