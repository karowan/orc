import { describe, expect, it } from "vitest";
import type { Executor } from "@karowanorg/orc-core";
import { makeExecHarness } from "@karowanorg/orc-ops";

function executorReturning(stdout: string): Executor {
  return {
    host: undefined,
    async run() {
      return { code: 0, stdout, stderr: "" };
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
