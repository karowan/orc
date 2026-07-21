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
