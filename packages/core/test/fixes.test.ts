import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { readJournal, readResult, readTraces, runPaths } from "../src/rundir.js";
import { latestLeafTraces } from "../src/status.js";
import { validateAgainstSchema } from "../src/jsonschema.js";
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

  it("cuts off a run whose estimated cost passes the budget", async () => {
    // Each leaf reports ~$0.60; a $1.00 budget survives leaf a (0.60) and trips
    // during leaf b (1.20 > 1.00) → the run fails terminally with a budget error.
    const registry = makeRegistry(makeFakeHarness({ costPerLeafUsd: 0.6 }));
    const { manifest, status } = await run("budget-seq.orc.ts", registry, { budgetUsd: 1.0 });
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/budget exceeded: estimated cost ~\$1\.20 passed the \$1\.00 budget/);
    // The cutoff is also narrated in the feed.
    const feed = readTraces(manifest.runId).filter((t) => t.t === "event");
    expect(JSON.stringify(feed)).toContain("cancelling run");
  });

  it("a run under its budget completes normally", async () => {
    const registry = makeRegistry(makeFakeHarness({ costPerLeafUsd: 0.6 }));
    const { status } = await run("budget-seq.orc.ts", registry, { budgetUsd: 10 });
    expect(status.state).toBe("completed");
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
    expect(hlogs[0]).toMatchObject({ seq: 0, message: "ERROR failed to renew cache TTL: missing field `x`" });
    // The orchestration feed carries none of it.
    const feedLogs = traces.filter((t) => t.t === "event" && t.event.kind === "log");
    expect(feedLogs.some((e) => JSON.stringify(e).includes("cache TTL"))).toBe(false);
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
    expect(validateAgainstSchema({ status: "a" }, schema)).toMatch(/missing required property "name"/);
    expect(validateAgainstSchema({ name: 5, status: "a" }, schema)).toMatch(/expected type string/);
    expect(validateAgainstSchema({ name: "x", status: "z" }, schema)).toMatch(/not in enum/);
    expect(validateAgainstSchema({ name: "x", status: "a", tags: ["ok", 3] }, schema)).toMatch(/tags\[1\]/);
  });
  it("accepts nullable unions", () => {
    expect(validateAgainstSchema(null, { type: ["string", "null"] })).toBeNull();
    expect(validateAgainstSchema("x", { type: ["string", "null"] })).toBeNull();
  });
});
