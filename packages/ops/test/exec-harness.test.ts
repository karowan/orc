import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Executor, HarnessContext, HarnessEvent, LeafRequest, Proc } from "@karowanorg/orc-core";
import { makeExecHarness } from "@karowanorg/orc-ops";

function executorReturning(stdout: string): Executor {
  return {
    async run() {
      return { code: 0, stdout, stderr: "" };
    },
  } as Executor;
}

/** Captures the request written to the child's stdin and replies with one result. */
function executorCapturingStdin(seen: { stdin?: string }, output: unknown): Executor {
  return {
    spawn(): Proc {
      return {
        stdin: { end: (payload: string) => { seen.stdin = payload; } },
        stdout: Readable.from([JSON.stringify({ kind: "result", output }) + "\n"]),
        stderr: Readable.from([]),
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
      } as unknown as Proc;
    },
  } as Executor;
}

describe("exec harness capabilities", () => {
  it("fails closed when an executable returns the wrong capability shape", async () => {
    const caps = await makeExecHarness("/tmp/custom").discover({
      executor: executorReturning(JSON.stringify({ available: true, models: "anything" })),
    });
    expect(caps.available).toBe(false);
    expect(caps.detail).toContain("exec harness unavailable");
  });

  it("accepts the documented capability shape", async () => {
    const caps = await makeExecHarness("/tmp/custom").discover({
      executor: executorReturning(JSON.stringify({
        available: true,
        models: [{ id: "m", reasoningEfforts: [] }],
        approvalModes: ["auto"],
        structuredOutput: true,
        sessions: false,
      })),
    });
    expect(caps.available).toBe(true);
    expect(caps.models[0]?.id).toBe("m");
  });
});

describe("exec harness protocol", () => {
  it("hands the composed context to the child verbatim, with no brief field", async () => {
    const seen: { stdin?: string } = {};
    const req: LeafRequest = {
      runId: "r",
      seq: 1,
      prompt: "do it",
      system: "system",
      context: "run ctx\n\nleaf ctx",
      readOnly: true,
      cwd: "/tmp",
      approvalMode: "auto",
    };
    const ctx = {
      executor: executorCapturingStdin(seen, { ok: true }),
      reportActivity: () => {},
      log: () => {},
      signal: new AbortController().signal,
      requestApproval: async () => ({ behavior: "deny" as const }),
    } as unknown as HarnessContext;
    const events: HarnessEvent[] = [];
    for await (const ev of makeExecHarness("/tmp/custom").invoke(req, ctx)) events.push(ev);
    expect(events).toEqual([{ kind: "result", output: { ok: true } }]);
    const wire = JSON.parse(seen.stdin!) as Record<string, unknown>;
    expect(wire.context).toBe("run ctx\n\nleaf ctx");
    expect("brief" in wire).toBe(false);
  });
});
