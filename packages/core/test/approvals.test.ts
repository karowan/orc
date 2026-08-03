import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun, type Registry } from "../src/supervisor.js";
import {
  appendControl,
  JsonlAppender,
  readResult,
  readTraces,
  runPaths,
} from "../src/rundir.js";
import { openApprovals } from "../src/status.js";
import type { ExtensionLeaf, Harness } from "../src/contracts.js";
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
    return {
      available: true,
      models: [],
      approvalModes: ["manual"],
      structuredOutput: true,
      sessions: false,
    };
  },
  async *invoke(req, ctx) {
    yield {
      kind: "tool-call-open",
      id: "t1",
      name: "Bash",
      input: { command: "rm -rf x" },
      atMs: Date.now(),
    };
    const decision = await ctx.requestApproval({
      runId: req.runId,
      seq: req.seq,
      toolName: "Bash",
      input: { command: "rm -rf x" },
    });
    yield {
      kind: "tool-call-close",
      id: "t1",
      status: decision.behavior === "allow" ? "ok" : "error",
      atMs: Date.now(),
    };
    yield {
      kind: "result",
      output: {
        behavior: decision.behavior,
        message: decision.message ?? null,
      },
    };
  },
};

function registry(): Registry {
  return {
    harnesses: new Map([["appr", approvalHarness]]),
    extensions: new Map(),
    defaultHarness: "appr",
    executor: fakeExecutor,
  };
}

async function launch(reg: Registry) {
  const program = path.join(home, "p.orc.ts");
  fs.writeFileSync(
    program,
    `export default async ({ agent }: any) => agent("do it", { id: "leaf" });\n`,
  );
  return prepareRun(
    { programPath: program, cwd: home, brief: "b", approvalMode: "manual" },
    reg,
  );
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
  it("projects extension UI data and resolves named approval actions", async () => {
    const extension: ExtensionLeaf = {
      name: "presented_gate",
      readOnly: true,
      present: {
        input: () => ({
          title: "Requirements gate",
          documents: [
            {
              label: "Requirements",
              path: "/tmp/requirements.html",
              mediaType: "text/html; charset=utf-8",
              content: "x".repeat(140 * 1024),
            },
          ],
        }),
        output: (_payload, result) => ({
          title: "Gate result",
          fields: [
            {
              label: "Action",
              value: String((result as { action?: unknown }).action),
            },
          ],
        }),
      },
      async execute(_payload, ctx) {
        const live = {
          title: "Live gate state",
          fields: [{ label: "State", value: "waiting" }],
          badges: [{ key: "live-state", label: "State", value: "waiting" }],
        };
        ctx.present(live);
        ctx.present(live);
        return ctx.requestApproval({
          runId: "spoofed",
          seq: 999,
          toolName: "example.document-gate",
          input: { secret: "raw payload is not projected" },
          presentation: {
            title: "Approve requirements",
            summary: "<script>unsafe</script>",
          },
          actions: [
            {
              id: "approve",
              label: "Approve",
              behavior: "allow",
              tone: "primary",
            },
            {
              id: "revise",
              label: "Request revision",
              behavior: "deny",
              message: { label: "Instructions", required: true },
            },
          ],
        });
      },
    };
    const reg = {
      ...registry(),
      extensions: new Map([[extension.name, extension]]),
    };
    const program = path.join(home, "presented-gate.orc.ts");
    fs.writeFileSync(
      program,
      `export default async ({ ext }: any) => ext.presented_gate({ hidden: "value" });\n`,
    );
    const manifest = await prepareRun(
      { programPath: program, cwd: home, brief: "b" },
      reg,
    );
    const running = superviseRun(manifest.runId, reg);

    await waitFor(() => openApprovals(readTraces(manifest.runId)).length === 1);
    const pending = openApprovals(readTraces(manifest.runId))[0]!;
    const runningLeaves = readTraces(manifest.runId).filter(
      (record) => record.t === "leaf",
    );
    expect(runningLeaves).toHaveLength(2);
    expect(
      runningLeaves.at(-1)?.t === "leaf"
        ? runningLeaves.at(-1)?.presentation?.live
        : undefined,
    ).toMatchObject({
      title: "Live gate state",
      fields: [{ label: "State", value: "waiting" }],
    });
    expect(pending).toMatchObject({
      runId: manifest.runId,
      seq: 0,
      presentation: {
        title: "Approve requirements",
        summary: "<script>unsafe</script>",
      },
      actions: [
        { id: "approve", behavior: "allow" },
        { id: "revise", behavior: "deny", message: { required: true } },
      ],
    });
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending.id,
      decision: {
        behavior: "deny",
        action: "revise",
        message: "Add rollback criteria",
      },
      by: "test",
      atMs: Date.now(),
    });

    const status = await running;
    const result = readResult(runPaths(manifest.runId), status.resultSha!) as {
      behavior: string;
      action: string;
      message: string;
    };
    expect(result).toEqual({
      behavior: "deny",
      action: "revise",
      message: "Add rollback criteria",
    });
    const leaf = readTraces(manifest.runId)
      .filter((record) => record.t === "leaf" && record.status === "ok")
      .at(-1);
    expect(
      leaf?.t === "leaf"
        ? leaf.presentation?.output?.fields?.[0]?.value
        : undefined,
    ).toBe("revise");
    expect(
      leaf?.t === "leaf"
        ? leaf.presentation?.live?.fields?.[0]?.value
        : undefined,
    ).toBe("waiting");
    const content =
      leaf?.t === "leaf"
        ? leaf.presentation?.input?.documents?.[0]?.content
        : undefined;
    expect(
      leaf?.t === "leaf"
        ? leaf.presentation?.input?.documents?.[0]?.mediaType
        : undefined,
    ).toBe("text/html; charset=utf-8");
    expect(Buffer.byteLength(content ?? "")).toBeLessThan(129 * 1024);
    expect(content).toContain("truncated");
    expect(
      readTraces(manifest.runId).filter((record) => record.t === "leaf"),
    ).toHaveLength(3);
  });

  it("rejects malformed presentation document media types", async () => {
    const extension: ExtensionLeaf = {
      name: "malformed_presentation",
      readOnly: true,
      async execute(_payload, ctx) {
        return ctx.requestApproval({
          runId: "spoofed",
          seq: 999,
          toolName: "invalid-document",
          input: {},
          presentation: {
            documents: [
              {
                label: "Invalid",
                path: "/tmp/invalid",
                mediaType: "not a media type",
              },
            ],
          },
        });
      },
    };
    const reg = {
      ...registry(),
      extensions: new Map([[extension.name, extension]]),
    };
    const program = path.join(home, "malformed-presentation.orc.ts");
    fs.writeFileSync(
      program,
      `export default async ({ ext }: any) => ext.malformed_presentation({});\n`,
    );
    const manifest = await prepareRun(
      { programPath: program, cwd: home, brief: "b" },
      reg,
    );

    const status = await superviseRun(manifest.runId, reg);

    expect(status.state).toBe("failed");
    expect(status.error).toContain("invalid presentation document media type");
  });

  it("stamps extension approvals with supervisor-owned run and sequence identity", async () => {
    const extension: ExtensionLeaf = {
      name: "gate",
      readOnly: true,
      async execute(_payload, ctx) {
        const decision = await ctx.requestApproval({
          runId: "spoofed",
          seq: 999,
          toolName: "example.document-gate",
          input: { document: "/tmp/requirements.md" },
        });
        return { behavior: decision.behavior };
      },
    };
    const reg = {
      ...registry(),
      extensions: new Map([["gate", extension]]),
    };
    const program = path.join(home, "gate.orc.ts");
    fs.writeFileSync(
      program,
      `export default async ({ ext }: any) => ext.gate({});\n`,
    );
    const manifest = await prepareRun(
      { programPath: program, cwd: home, brief: "b" },
      reg,
    );
    const runPromise = superviseRun(manifest.runId, reg);

    await waitFor(() => openApprovals(readTraces(manifest.runId)).length === 1);
    const pending = openApprovals(readTraces(manifest.runId))[0];
    expect(pending.runId).toBe(manifest.runId);
    expect(pending.seq).toBe(0);
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending.id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });
    expect((await runPromise).state).toBe("completed");
  });

  it("does not apply the leaf idle timeout while waiting for operator approval", async () => {
    const extension: ExtensionLeaf = {
      name: "gate_without_timeout",
      readOnly: true,
      async execute(_payload, ctx) {
        const decision = await ctx.requestApproval({
          runId: "spoofed",
          seq: 999,
          toolName: "example.document-gate",
          input: {},
        });
        return { behavior: decision.behavior };
      },
    };
    const reg = {
      ...registry(),
      extensions: new Map([[extension.name, extension]]),
    };
    const program = path.join(home, "gate-without-timeout.orc.ts");
    fs.writeFileSync(
      program,
      `export default async ({ ext }: any) => ext.gate_without_timeout({});\n`,
    );
    const manifest = await prepareRun(
      {
        programPath: program,
        cwd: home,
        brief: "b",
        idleTimeout: 25,
      },
      reg,
    );
    let settled = false;
    const runPromise = superviseRun(manifest.runId, reg).finally(() => {
      settled = true;
    });

    await waitFor(() => openApprovals(readTraces(manifest.runId)).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(settled).toBe(false);
    const pending = openApprovals(readTraces(manifest.runId));
    expect(pending).toHaveLength(1);
    appendControl(manifest.runId, {
      t: "approval",
      approvalId: pending[0].id,
      decision: { behavior: "allow" },
      by: "test",
      atMs: Date.now(),
    });

    expect((await runPromise).state).toBe("completed");
  });

  it("honors a cancel queued before the first supervisor starts", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    expect((await superviseRun(manifest.runId, reg)).state).toBe("cancelled");
    expect(
      readTraces(manifest.runId).filter((record) => record.t === "leaf"),
    ).toHaveLength(0);
  });

  it("honors a cancel queued after an unfinished supervisor crash", async () => {
    const reg = registry();
    const manifest = await launch(reg);
    const journal = new JsonlAppender(runPaths(manifest.runId).journal);
    journal.append({ t: "attempt", seq: 0, attempt: 1, atMs: Date.now() });
    journal.close();
    appendControl(manifest.runId, { t: "cancel", atMs: Date.now() });

    expect((await superviseRun(manifest.runId, reg)).state).toBe("cancelled");
    expect(
      readTraces(manifest.runId).filter((record) => record.t === "leaf"),
    ).toHaveLength(0);
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
    const body = readResult(runPaths(manifest.runId), status.resultSha!) as {
      behavior: string;
    };
    expect(body.behavior).toBe("allow");
    // and there's an approval-resolved event in the trace
    const events = readTraces(manifest.runId).filter((t) => t.t === "event");
    expect(
      events.some(
        (e) => e.t === "event" && e.event.kind === "approval-resolved",
      ),
    ).toBe(true);
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
    const body = readResult(runPaths(manifest.runId), status.resultSha!) as {
      behavior: string;
      message: string;
    };
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
    const manifest = await prepareRun(
      { programPath: program, cwd: home, brief: "b", approvalMode: "manual" },
      reg,
    );
    const runPromise = superviseRun(manifest.runId, reg);

    // All 4 bubble simultaneously as distinct pending approvals.
    await waitFor(() => openApprovals(readTraces(manifest.runId)).length === 4);
    const pending = openApprovals(readTraces(manifest.runId));
    expect(pending).toHaveLength(4);
    expect(new Set(pending.map((a) => a.id)).size).toBe(4); // unique ids
    expect(new Set(pending.map((a) => a.seq))).toEqual(new Set([0, 1, 2, 3]));

    // Answer them out of order, mixing allow/deny — each resolves on its own id.
    const decisions: Record<number, "allow" | "deny"> = {
      0: "allow",
      1: "deny",
      2: "allow",
      3: "deny",
    };
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
      const leaf = traces.find(
        (t) => t.t === "leaf" && t.seq === Number(seq) && t.status === "ok",
      );
      const out =
        leaf && leaf.t === "leaf"
          ? (leaf.output as { behavior?: string })
          : undefined;
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
