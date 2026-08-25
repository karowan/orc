/**
 * Live smoke test against the real `codex app-server` — skipped unless
 * ORC_CODEX_LIVE=1. Costs one tiny turn.
 *
 *   ORC_CODEX_LIVE=1 npx vitest run packages/harness-codex/test/live.test.ts
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessContext, HarnessEvent } from "@karowanorg/orc-core";
import { LocalExecutor } from "@karowanorg/orc-executors";
import { codexHarness } from "../src/harness.js";

const live = process.env.ORC_CODEX_LIVE === "1";

describe.skipIf(!live)("codexHarness (live)", () => {
  it("runs a trivial structured turn end to end", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "orc-codex-live-"));
    const ctx: HarnessContext = {
      executor: new LocalExecutor(),
      reportActivity: () => undefined,
      requestApproval: async () => ({ behavior: "deny", message: "live test is read-only" }),
      signal: new AbortController().signal,
      log: () => {},
    };
    const events: HarnessEvent[] = [];
    for await (const ev of codexHarness.invoke(
      {
        runId: "live-run",
        seq: 1,
        prompt: 'Reply with exactly the JSON {"ok":true}',
        system: "",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        reasoningEffort: "low",
        readOnly: true,
        cwd,
        approvalMode: "auto",
      },
      ctx,
    )) {
      events.push(ev);
    }
    const session = events.find((e) => e.kind === "session");
    expect(session && session.kind === "session" && session.sessionId).toBeTruthy();
    const result = events.find((e) => e.kind === "result");
    expect(result, `no result; events: ${JSON.stringify(events).slice(0, 2000)}`).toBeDefined();
    expect(result!.kind === "result" && result!.output).toEqual({ ok: true });
  }, 180_000);

  it("discovers live capabilities", async () => {
    const caps = await codexHarness.discover({ executor: new LocalExecutor() });
    expect(caps.available).toBe(true);
    expect(caps.models.length).toBeGreaterThan(0);
    expect(caps.models.some((m) => m.reasoningEfforts.length > 0)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[live] codex capabilities:", JSON.stringify(caps));
  }, 60_000);
});
