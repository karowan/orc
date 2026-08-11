import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Executor, HarnessContext, HarnessEvent, LeafRequest } from "@karowanorg/orc-core";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
}));

import { claudeHarness } from "../src/index.js";

function req(overrides: Partial<LeafRequest> = {}): LeafRequest {
  return {
    runId: "r",
    seq: 1,
    prompt: "do it",
    system: "system",
    brief: "brief",
    readOnly: true,
    cwd: "/workspace",
    approvalMode: "auto",
    ...overrides,
  };
}

function context(executor: Executor, signal = new AbortController().signal, logs: string[] = []): HarnessContext {
  return {
    executor,
    signal,
    log: (line) => logs.push(line),
    reportActivity: () => undefined,
    requestApproval: async () => ({ behavior: "allow" }),
  };
}

async function collect(request: LeafRequest, ctx: HarnessContext): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of claudeHarness.invoke(request, ctx)) events.push(event);
  return events;
}

const unusedExecutor = {
  spawn(): never {
    throw new Error("not used");
  },
  async run() {
    throw new Error("not used");
  },
  async exists() {
    return false;
  },
  async readFile() {
    throw new Error("not used");
  },
  async writeFile() {},
} satisfies Executor;

describe("claude local policy", () => {
  it("does not impose an SDK turn limit on agent leaves", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(req(), context(unusedExecutor));

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options).not.toHaveProperty("maxTurns");
  });

  it("streams exact cumulative cost without double-counting split assistant frames", async () => {
    const readUsage = vi
      .fn()
      .mockResolvedValueOnce({ session: { total_cost_usd: 1 } })
      .mockResolvedValueOnce({ session: { total_cost_usd: 1.12 } })
      .mockResolvedValueOnce({ session: { total_cost_usd: 1.12 } })
      .mockResolvedValueOnce({ session: { total_cost_usd: 1.2 } })
      .mockResolvedValueOnce({ session: { total_cost_usd: 1.34 } });
    sdk.query.mockReturnValueOnce({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: readUsage,
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "session-1" };
        yield {
          type: "assistant",
          message: {
            id: "message-1",
            model: "claude-opus",
            usage: { input_tokens: 10, output_tokens: 3 },
            content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a" } }],
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "message-1",
            model: "claude-opus",
            usage: { input_tokens: 10, output_tokens: 3 },
            content: [{ type: "text", text: "Reading." }],
          },
        };
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "message-2",
            model: "claude-opus",
            usage: { input_tokens: 5, output_tokens: 7 },
            content: [{ type: "text", text: '{"ok":true}' }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "session-1",
          usage: { input_tokens: 15, output_tokens: 10 },
          total_cost_usd: 0.3,
          result: '{"ok":true}',
        };
      },
    });

    const events = await collect(req({ sessionId: "prior-session" }), context(unusedExecutor));
    const usage = events.filter(
      (event): event is Extract<HarnessEvent, { kind: "usage" }> => event.kind === "usage",
    );
    const liveCosts = usage.filter((event) => event.costUsd !== undefined);

    expect(readUsage).toHaveBeenCalledTimes(5);
    expect(usage.filter((event) => event.costUsd === undefined)).toEqual([
      { kind: "usage", tokensIn: 10, tokensOut: 3 },
      { kind: "usage", tokensIn: 15, tokensOut: 10 },
    ]);
    expect(liveCosts.map((event) => event.costUsd)).toEqual([
      expect.closeTo(0.12),
      expect.closeTo(0.12),
      expect.closeTo(0.2),
      expect.closeTo(0.34),
      expect.closeTo(0.3),
    ]);
    expect(liveCosts.slice(0, -1).every((event) => event.costEstimated === false)).toBe(true);
    expect(events).toContainEqual({ kind: "result", output: { ok: true } });
  });

  it("preserves synthetic auth and quota failures instead of validating them as model JSON", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            model: "<synthetic>",
            content: [{ type: "text", text: "You've hit your session limit · resets 12pm" }],
          },
        };
        yield { type: "result", subtype: "success", result: "You've hit your session limit · resets 12pm" };
      },
    });

    const events = await collect(req({ schema: { type: "object", required: ["findings"] } }), context(unusedExecutor));

    expect(events).toContainEqual({
      kind: "error",
      message: "claude unavailable: You've hit your session limit · resets 12pm",
    });
    expect(events.some((event) => event.kind === "result")).toBe(false);
  });

  it("keeps read-only authoritative over bypass while preserving configured MCPs", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(req({ approvalMode: "bypass", sandbox: true }), context(unusedExecutor));

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.strictMcpConfig).toBe(false);
    expect(options.disallowedTools).toEqual(["Bash", "Edit", "Write", "NotebookEdit"]);
    expect(options.canUseTool).toBeUndefined();
  });

  it("grants read-only leaves access to every declared workspace root", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(
      req({
        sandbox: true,
        cwd: "/workspace/package-a",
        sandboxDirs: ["../package-b", "/workspace/package-c"],
      }),
      context(unusedExecutor),
    );

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.disallowedTools).toEqual(["Bash", "Edit", "Write", "NotebookEdit"]);
    expect(options.additionalDirectories).toEqual([
      "/workspace/package-b",
      "/workspace/package-c",
    ]);
    expect(options.sandbox).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
  });

  it("retains explicit bypass power for write leaves", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(req({ readOnly: false, approvalMode: "bypass" }), context(unusedExecutor));

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.disallowedTools).toBeUndefined();
  });

  it("uses the SDK's fail-closed native sandbox for cwd plus sandboxDirs", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(
      req({
        readOnly: false,
        sandbox: true,
        cwd: "/workspace",
        sandboxDirs: ["../cache", "/opt/build-cache"],
      }),
      context(unusedExecutor),
    );

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.canUseTool).toBeTypeOf("function");
    expect(options.additionalDirectories).toEqual(["/cache", "/opt/build-cache"]);
    expect(options.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ["/workspace", "/cache", "/opt/build-cache"] },
    });
    const callbackOptions = { signal: new AbortController().signal };
    await expect(
      options.canUseTool!("Edit", { file_path: "/workspace/src/a.ts" }, callbackOptions),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      options.canUseTool!("Edit", { file_path: "/etc/passwd" }, callbackOptions),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      options.canUseTool!(
        "Edit",
        { file_path: "/workspace/link" },
        { ...callbackOptions, blockedPath: "/etc/passwd" },
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("forwards only the user AWS credential helper into an isolated write sandbox", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-claude-config-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        awsCredentialExport: "/usr/local/bin/export-bedrock-credentials",
        permissions: { allow: ["Bash(*)"] },
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    try {
      await collect(
        req({ readOnly: false, sandbox: true }),
        context(unusedExecutor),
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
    }

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({
      awsCredentialExport: "/usr/local/bin/export-bedrock-credentials",
    });
  });

  it("allows outbound network without weakening filesystem confinement", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(
      req({ readOnly: false, sandbox: true, networkAccess: true }),
      context(unusedExecutor),
    );

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ["/workspace"] },
      network: { allowedDomains: ["*"], allowLocalBinding: true },
    });
  });

  it("keeps bypass autonomous but confined when sandboxing is requested", async () => {
    sdk.query.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {},
    });

    await collect(
      req({ readOnly: false, approvalMode: "bypass", sandbox: true }),
      context(unusedExecutor),
    );

    const options = (sdk.query.mock.calls.at(-1)![0] as { options: Options }).options;
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.canUseTool).toBeTypeOf("function");
  });
});
