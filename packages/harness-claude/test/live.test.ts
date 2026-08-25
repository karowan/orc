import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeHarness } from "../src/index.js";
import type { HarnessContext, HarnessEvent, LeafRequest } from "@karowanorg/orc-core";

const LIVE = process.env.ORC_CLAUDE_LIVE === "1";

// Minimal local executor good enough for discover(); invoke() uses the SDK.
const localExec = {
  spawn(): never {
    throw new Error("not needed");
  },
  async run(cmd: string[]) {
    const { execFile } = await import("node:child_process");
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(cmd[0], cmd.slice(1), { timeout: 20_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  },
  async exists() {
    return false;
  },
  async readFile(): Promise<string> {
    throw new Error("no");
  },
  async writeFile(): Promise<void> {},
};

function ctx(): HarnessContext {
  return {
    executor: localExec,
    signal: new AbortController().signal,
    log: () => undefined,
    reportActivity: () => undefined,
    requestApproval: async () => ({ behavior: "allow" as const }),
  };
}

describe.skipIf(!LIVE)("claude harness (live)", () => {
  it("runs a tiny structured leaf via the Agent SDK", async (t) => {
    // Skip when local claude auth is unavailable (e.g. nested-session keychain).
    const probe = await localExec.run(["claude", "-p", "Reply OK"]);
    if (/not logged in|failed to authenticate/i.test(probe.stdout + probe.stderr)) {
      t.skip();
      return;
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orc-claude-live-"));
    const req: LeafRequest = {
      runId: "r_test",
      seq: 0,
      prompt: 'Reply with exactly the JSON {"ok": true}. Do not use any tools.',
      system: "You are a test leaf. Answer directly.",
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      readOnly: true,
      cwd,
      approvalMode: "auto",
      idleTimeoutMs: false,
    };
    const events: HarnessEvent[] = [];
    for await (const ev of claudeHarness.invoke(req, ctx())) events.push(ev);
    const result = events.find((e) => e.kind === "result");
    expect(result, JSON.stringify(events.filter((e) => e.kind === "error"))).toBeDefined();
    expect((result as Extract<HarnessEvent, { kind: "result" }>).output).toEqual({ ok: true });
    expect(events.some((e) => e.kind === "session")).toBe(true);
  }, 180_000);

  it("discover() reports models natively", async () => {
    const caps = await claudeHarness.discover({ executor: localExec });
    expect(caps.available).toBe(true);
    expect(caps.version).toMatch(/\d+\.\d+/);
  }, 60_000);
});
