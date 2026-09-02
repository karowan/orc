import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { readJournal, readManifest } from "../src/rundir.js";
import { DEFAULT_POLICY, MAX_COMMANDS_CEILING, type ExtensionLeaf, type Policy } from "../src/contracts.js";
import { makeFakeHarness, makeRegistry, type FakeHarnessOptions } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-policy-caps-"));
  process.env.ORC_HOME = home;
});

function pollExt(readOnly: boolean): ExtensionLeaf {
  return { name: "poll", readOnly, execute: async (payload) => ({ polled: payload }) };
}

function registryWith(readOnlyPoll: boolean, harness: FakeHarnessOptions = {}) {
  return makeRegistry(makeFakeHarness(harness), { extensions: new Map([["poll", pollExt(readOnlyPoll)]]) });
}

function callCounts(runId: string): { agent: number; ext: number } {
  const calls = readJournal(runId).filter((r) => r.t === "call");
  return {
    agent: calls.filter((r) => r.kind === "agent").length,
    ext: calls.filter((r) => r.kind !== "agent").length,
  };
}

async function run(program: string, registry: ReturnType<typeof registryWith>, policy: Policy, launch: Record<string, unknown> = {}) {
  const manifest = await prepareRun({ programPath: FIX(program), cwd: home, ...launch }, registry);
  const status = await superviseRun(manifest.runId, registry, {}, policy);
  return { manifest, status };
}

describe("maxCommands counts work, not read-only ext polls", () => {
  it("read-only ext calls do not spend maxCommands", async () => {
    // 6 polls + 3 agents = 9 calls; a seq-based cap of 3 would have killed it.
    const { manifest, status } = await run("polls-then-work.orc.ts", registryWith(true), { ...DEFAULT_POLICY, maxCommands: 3 });
    expect(status.state).toBe("completed");
    expect(callCounts(manifest.runId)).toEqual({ agent: 3, ext: 6 });
  });

  it("agent leaves still trip maxCommands", async () => {
    const { manifest, status } = await run("polls-then-work.orc.ts", registryWith(true), { ...DEFAULT_POLICY, maxCommands: 2 });
    expect(status.state).toBe("failed");
    expect(status.error).toContain("program exceeded maxCommands (2)");
    expect(callCounts(manifest.runId)).toEqual({ agent: 2, ext: 6 });
  });

  it("read-only ext calls have their own runaway bound", async () => {
    const { manifest, status } = await run("polls-then-work.orc.ts", registryWith(true), { ...DEFAULT_POLICY, maxReadOnlyExtCommands: 5 });
    expect(status.state).toBe("failed");
    expect(status.error).toContain("program exceeded maxReadOnlyExtCommands (5)");
    expect(callCounts(manifest.runId)).toEqual({ agent: 0, ext: 5 });
  });

  it("write ext calls are work and spend maxCommands", async () => {
    const { manifest, status } = await run(
      "polls-then-work.orc.ts",
      registryWith(false),
      { ...DEFAULT_POLICY, maxCommands: 5 },
      { allowWrites: true },
    );
    expect(status.state).toBe("failed");
    expect(status.error).toContain("program exceeded maxCommands (5)");
    expect(callCounts(manifest.runId)).toEqual({ agent: 0, ext: 5 });
  });
});

describe("per-run maxCommands override", () => {
  it("is stored in the manifest and enforced over the process policy", async () => {
    const { manifest, status } = await run("polls-then-work.orc.ts", registryWith(true), DEFAULT_POLICY, { maxCommands: 2 });
    expect(readManifest(manifest.runId).maxCommands).toBe(2);
    expect(status.state).toBe("failed");
    expect(status.error).toContain("program exceeded maxCommands (2)");
  });

  it("is clamped to the ceiling and rejects non-positive values", async () => {
    const registry = registryWith(true);
    const clamped = await prepareRun({ programPath: FIX("polls-then-work.orc.ts"), cwd: home, maxCommands: 10_000 }, registry);
    expect(readManifest(clamped.runId).maxCommands).toBe(MAX_COMMANDS_CEILING);
    const absent = await prepareRun({ programPath: FIX("polls-then-work.orc.ts"), cwd: home }, registry);
    expect(readManifest(absent.runId).maxCommands).toBeUndefined();
    await expect(prepareRun({ programPath: FIX("polls-then-work.orc.ts"), cwd: home, maxCommands: 0 }, registry)).rejects.toThrow(
      "maxCommands must be a positive integer",
    );
  });

  it("survives a resume: counters rebuild from the journal, polls excluded", async () => {
    // seq 0-2 polls, seq 3 = a, seq 4 = b (fails on the first run), then c, d.
    const first = await run("polls-then-chain.orc.ts", registryWith(true, { failSeqs: [4] }), DEFAULT_POLICY, { maxCommands: 3 });
    expect(first.status.state).toBe("failed");
    expect(first.status.error).not.toContain("maxCommands");
    expect(callCounts(first.manifest.runId)).toEqual({ agent: 2, ext: 3 });

    const resumed = await superviseRun(first.manifest.runId, registryWith(true));
    // Replayed a + retried b + new c fill the cap of 3; d trips it. Had polls
    // been counted, c would have tripped it; had nothing been rebuilt, d would
    // have passed.
    expect(resumed.state).toBe("failed");
    expect(resumed.error).toContain("program exceeded maxCommands (3)");
    expect(callCounts(first.manifest.runId)).toEqual({ agent: 3, ext: 3 });
  });
});
