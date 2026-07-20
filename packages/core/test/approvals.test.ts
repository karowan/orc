import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun, type Registry } from "../src/supervisor.js";
import { appendControl, JsonlAppender, readResult, readTraces, runPaths } from "../src/rundir.js";
import { openApprovals } from "../src/status.js";
import type { Harness } from "../src/contracts.js";
import { fakeExecutor } from "./helpers/fake.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-appr-"));
  process.env.ORC_HOME = home;
});

/** A harness that requests approval for a "Bash" tool, then reports the decision. */
const approvalHarness: Harness = {
  name: "appr",
  async discover() {
    return { available: true, models: [], approvalModes: ["manual"], structuredOutput: true, sessions: false };
  },
  async *invoke(req, ctx) {
    yield { kind: "tool-call-open", id: "t1", name: "Bash", input: { command: "rm -rf x" }, atMs: Date.now() };
    const decision = await ctx.requestApproval({ runId: req.runId, seq: req.seq, toolName: "Bash", input: { command: "rm -rf x" } });
    yield { kind: "tool-call-close", id: "t1", status: decision.behavior === "allow" ? "ok" : "error", atMs: Date.now() };
    yield { kind: "result", output: { behavior: decision.behavior, message: decision.message ?? null } };
  },
};

function registry(): Registry {
  return { harnesses: new Map([["appr", approvalHarness]]), extensions: new Map(), defaultHarness: "appr", executorFor: () => fakeExecutor };
}

async function launch(reg: Registry) {
  const program = path.join(home, "p.orc.ts");
  fs.writeFileSync(program, `export default async ({ agent }: any) => agent("do it", { id: "leaf" });\n`);
  return prepareRun({ programPath: program, cwd: home, brief: "b", approvalMode: "manual" }, reg);
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for condition");
}

describe("permission bubbling (end to end)", () => {
  it("honors a cancel queued before the first supervisor starts", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    expect((await superviseRun(manifest.runId, reg)).state).toBe("cancelled");
    expect(readTraces(manifest.runId).filter((record) => record.t === "leaf")).toHaveLength(0);
  });

  it("honors a cancel queued after an unfinished supervisor crash", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const journal = new JsonlAppender(runPaths(manifest.runId).journal);
    journal.append({ t: "attempt", seq: 0, attempt: 1, atMs: Date.now() });
    journal.close();
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    expect((await superviseRun(manifest.runId, reg)).state).toBe("cancelled");
    expect(readTraces(manifest.runId).filter((record) => record.t === "leaf")).toHaveLength(0);
  });

  it("does not replay controls from a cancelled supervisor when the run resumes", async () => {
    const reg = registry();
    const manifest = await launch(reg);

    const firstRun = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    const oldApproval = openApprovals(readTraces(manifest.runId))[0];
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });
    expect((await firstRun).state).toBe("cancelled");

    const resumedRun = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    const pending = openApprovals(readTraces(manifest.runId))[0];
    expect(pending.id).not.toBe(oldApproval.id);
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending.id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });

    expect((await resumedRun).state).toBe("completed");
  });

  it("keeps the control epoch after a resumed run crashes", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const firstRun = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });
    expect((await firstRun).state).toBe("cancelled");

    // A resume durably re-armed the run, then crashed before dispatch.
    const journal = new JsonlAppender(runPaths(manifest.runId).journal);
    journal.append({ t: "retry", seqs: [], atMs: Date.now() });
    journal.close();

    const resumedRun = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    const pending = openApprovals(readTraces(manifest.runId))[0];
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending.id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });
    expect((await resumedRun).state).toBe("completed");
  });

  it("expires an approval abandoned by a crashed supervisor before asking again", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const abandonedId = "a_abandoned";
    const traces = new JsonlAppender(runPaths(manifest.runId).traces);
    traces.append({
      t: "event",
      atMs: Date.now(),
      event: {
        kind: "approval-requested",
        approval: {
          id: abandonedId,
          runId: manifest.runId,
          seq: 0,
          toolName: "Bash",
          input: { command: "rm -rf x" },
          requestedAtMs: Date.now(),
        },
      },
    });
    traces.close();

    const resumedRun = superviseRun(manifest.runId, reg);
    await waitFor(() => {
      const pending = openApprovals(readTraces(manifest.runId));
      return pending.length === 1 && pending[0].id !== abandonedId;
    });
    const pending = openApprovals(readTraces(manifest.runId));
    expect(pending).toHaveLength(1);
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending[0].id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });
    expect((await resumedRun).state).toBe("completed");
  });

  it("bubbles an approval, blocks the leaf, and resolves it on an allow", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const runPromise = superviseRun(manifest.runId, reg);

    // The approval request shows up as a pending approval + a journaled event.
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    const pending = openApprovals(readTraces(manifest.runId));
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("Bash");
    expect(pending[0].seq).toBe(0);

    // Operator (or agent via MCP) answers — exactly what `orc respond` / the UI do.
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending[0].id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });

    const status = await runPromise;
    expect(status.state).toBe("completed");
    // the leaf saw the allow decision
    const body = readResult(runPaths(manifest.runId), status.resultSha!) as { behavior: string };
    expect(body.behavior).toBe("allow");
    // and there's an approval-resolved event in the trace
    const events = readTraces(manifest.runId).filter((t) => t.t === "event");
    expect(events.some((e) => e.t === "event" && e.event.kind === "approval-resolved")).toBe(true);
    // no approvals left pending
    expect(openApprovals(readTraces(manifest.runId))).toHaveLength(0);
  });

  it("propagates a deny with the operator's message", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const runPromise = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    const pending = openApprovals(readTraces(manifest.runId))[0];
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending.id,
      decision: { behavior: "deny", message: "nope, too dangerous" },
      by: "test",
      atMs: Date.now(),
    });
    const status = await runPromise;
    expect(status.state).toBe("completed");
    const body = readResult(runPaths(manifest.runId), status.resultSha!) as { behavior: string; message: string };
    expect(body.behavior).toBe("deny");
    expect(body.message).toBe("nope, too dangerous");
  });

  it("queues multiple simultaneous approvals from a fanout, each resolved independently", async () => {
    const reg = registry();
    // 4 leaves fan out and ALL request approval at once.
    const program = path.join(home, "fan.orc.ts");
    fs.writeFileSync(
      program,
      `export default async ({ parallel }: any) =>
         parallel([{prompt:"a"},{prompt:"b"},{prompt:"c"},{prompt:"d"}]);\n`,
    );
    const manifest = await prepareRun({ programPath: program, cwd: home, brief: "b", approvalMode: "manual" }, reg);
    const runPromise = superviseRun(manifest.runId, reg);

    // All 4 bubble simultaneously as distinct pending approvals.
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length === 4);
    const pending = openApprovals(readTraces(manifest.runId));
    expect(pending).toHaveLength(4);
    expect(new Set(pending.map((a) => a.id)).size).toBe(4); // unique ids
    expect(new Set(pending.map((a) => a.seq))).toEqual(new Set([0, 1, 2, 3]));

    // Answer them out of order, mixing allow/deny — each resolves on its own id.
    const decisions: Record<number, "allow" | "deny"> = { 0: "allow", 1: "deny", 2: "allow", 3: "deny" };
    for (const a of [...pending].reverse()) {
      appendControl(manifest.runId, {
        t: "approval",
        approvalId: a.id,
        decision: { behavior: decisions[a.seq] },
        by: "test",
        atMs: Date.now(),
      });
    }
    const status = await runPromise;
    expect(status.state).toBe("completed");
    expect(openApprovals(readTraces(manifest.runId))).toHaveLength(0);
    // each leaf saw its own decision
    const traces = readTraces(manifest.runId);
    for (const [seq, want] of Object.entries(decisions)) {
      const leaf = traces.find((t) => t.t === "leaf" && t.seq === Number(seq) && t.status === "ok");
      const out = leaf && leaf.t === "leaf" ? (leaf.output as { behavior?: string }) : undefined;
      expect(out?.behavior, `seq ${seq}`).toBe(want);
    }
  });

  it("denies a pending approval when the run is cancelled", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const runPromise = superviseRun(manifest.runId, reg);
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length > 0);
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });
    const status = await runPromise;
    expect(status.state).toBe("cancelled");
    expect(status.running).toBe(0);
    expect(status.leaves.some((leaf) => leaf.status === "running")).toBe(false);
    expect(openApprovals(readTraces(manifest.runId))).toHaveLength(0);
  });
});
