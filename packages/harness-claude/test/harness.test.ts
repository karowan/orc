import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Executor, HarnessContext, HarnessEvent, LeafRequest, Proc } from "@orc/core";
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
  host: undefined,
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

class RemoteExecutor implements Executor {
  readonly host = "remote";
  args: string[] | undefined;
  spawns = 0;

  constructor(
    private readonly stdinFactory: () => Writable = () => new PassThrough(),
    private readonly holdPipesOpen = false,
  ) {}

  spawn(cmd: string[]): Proc {
    this.spawns++;
    this.args = cmd;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = this.stdinFactory();
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    setImmediate(() => {
      const result =
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: '{"ok":true}',
        }) + "\n";
      if (this.holdPipesOpen) stdout.write(result);
      else stdout.end(result);
      exit(0);
      if (!this.holdPipesOpen) setImmediate(() => stderr.end("late remote trace\n"));
    });
    return { stdin, stdout, stderr, exited, kill: () => exit(-1), pid: 1 };
  }

  async run() {
    throw new Error("not used");
  }
  async exists() {
    return false;
  }
  async readFile() {
    throw new Error("not used");
  }
  async writeFile() {}
}

describe("claude remote transport", () => {
  it("keeps configured MCPs in read-only mode while disabling direct command and write tools", async () => {
    const executor = new RemoteExecutor();

    await collect(
      req({ host: "remote", approvalMode: "bypass", sandbox: true }),
      context(executor),
    );

    expect(executor.args!.some((arg) => arg.startsWith("--setting-sources"))).toBe(false);
    expect(executor.args).not.toContain("--strict-mcp-config");
    expect(executor.args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk"]));
    expect(executor.args).not.toContain("bypassPermissions");
    expect(executor.args).not.toContain("--dangerously-skip-permissions");
    const disallowedIndex = executor.args!.indexOf("--disallowedTools");
    expect(executor.args!.slice(disallowedIndex, disallowedIndex + 2)).toEqual([
      "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit",
    ]);
  });

  it("uses native sandbox settings, declares extra roots, and drains stderr after exit", async () => {
    const executor = new RemoteExecutor();
    const logs: string[] = [];
    const events = await collect(
      req({
        host: "remote",
        readOnly: false,
        approvalMode: "bypass",
        sandbox: true,
        sandboxDirs: ["/cache"],
      }),
      context(executor, undefined, logs),
    );

    expect(events.some((event) => event.kind === "result")).toBe(true);
    expect(executor.args).toContain("--setting-sources=");
    expect(executor.args).toContain("--strict-mcp-config");
    expect(executor.args).toContain("acceptEdits");
    expect(executor.args).not.toContain("--dangerously-skip-permissions");
    expect(executor.args).toContain("--add-dir");
    expect(executor.args).toContain("/cache");
    const settingsIndex = executor.args!.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(JSON.parse(executor.args![settingsIndex + 1])).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: ["/workspace", "/cache"] },
      },
    });
    expect(logs).toContain("late remote trace");
  });

  it("does not spawn for an already-aborted request", async () => {
    const executor = new RemoteExecutor();
    const controller = new AbortController();
    controller.abort("cancelled");

    const events = await collect(req({ host: "remote" }), context(executor, controller.signal));

    expect(executor.spawns).toBe(0);
    expect(events).toEqual([{ kind: "error", message: "aborted: cancelled" }]);
  });

  it("handles EPIPE from a child that closes stdin", async () => {
    const executor = new RemoteExecutor(
      () =>
        new (class extends Writable {
          override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
          }
        })(),
    );

    const events = await collect(req({ host: "remote" }), context(executor));

    expect(events.some((event) => event.kind === "result")).toBe(true);
  });

  it("bounds post-exit draining when descendants retain stdout and stderr", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const pending = collect(
        req({ host: "remote" }),
        context(new RemoteExecutor(undefined, true), undefined, logs),
      );

      await vi.advanceTimersByTimeAsync(10_001);
      const events = await pending;

      expect(events.some((event) => event.kind === "result")).toBe(true);
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringContaining("stdout remained open"),
          expect.stringContaining("stderr remained open"),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
