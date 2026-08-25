import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAppender, readControl, runPaths, type RunManifest, type TraceRecord } from "@karowanorg/orc-core";
import { Orc } from "@karowanorg/orc-sdk";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.ORC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-sdk-"));
  process.env.ORC_HOME = path.join(home, ".orc");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRunningRun(runId: string): void {
  const paths = runPaths(runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  const manifest: RunManifest = {
    runId,
    programPath: path.join(home, "program.orc.ts"),
    programSha256: "deadbeef",
    cwd: home,
    allowWrites: false,
    approvalMode: "auto",
    sandbox: false,
    sandboxDirs: [],
    networkAccess: false,
    maxParallel: 1,
    idleTimeoutMs: false,
    defaultHarness: "codex",
    createdAtMs: Date.now(),
    orcVersion: "0.1.0",
  };
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  fs.writeFileSync(paths.journal, "");
  fs.writeFileSync(paths.traces, "");
}

function writeApproval(runId: string, approvalId: string): void {
  const traces = new JsonlAppender<TraceRecord>(runPaths(runId).traces);
  traces.append({
    t: "event",
    atMs: Date.now(),
    event: {
      kind: "approval-requested",
      approval: {
        id: approvalId,
        runId,
        seq: 0,
        toolName: "example.document-gate",
        input: {},
        requestedAtMs: Date.now(),
      },
    },
  });
  traces.close();
}

describe("@karowanorg/orc-sdk", () => {
  it("launches through the package-owned entry with the SDK registry cwd", async () => {
    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir);
    const harnessPath = path.join(home, "custom-harness.mjs");
    fs.writeFileSync(
      harnessPath,
      `#!/usr/bin/env node
if (process.argv.includes("--capabilities")) {
  process.stdout.write(JSON.stringify({
    available: true,
    models: [],
    approvalModes: ["auto"],
    structuredOutput: true,
    sessions: false
  }) + "\\n");
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ kind: "result", output: { custom: true } }) + "\\n");
  });
}
`,
    );
    fs.chmodSync(harnessPath, 0o755);
    fs.writeFileSync(
      path.join(configDir, "orc.config.json"),
      JSON.stringify({
        defaultHarness: "custom",
        harnesses: [{ name: "custom", exec: harnessPath }],
      }),
    );
    const programPath = path.join(home, "done.orc.ts");
    fs.writeFileSync(programPath, `export default async ({ agent }: any) => agent("use custom");\n`);
    const previousEntry = process.argv[1];
    process.argv[1] = path.join(home, "definitely-not-the-orc-cli.js");
    try {
      // This intentionally supplies only caller-required fields: LaunchInput
      // is the Zod input type, so output defaults remain optional.
      const run = await new Orc({ cwd: configDir }).launch({ programPath });
      expect((await run.wait(10)).state).toBe("completed");
      expect(await run.result()).toEqual({ custom: true });
    } finally {
      process.argv[1] = previousEntry ?? "";
    }
  }, 30_000);

  it("parses timeout bounds before waiting", async () => {
    await expect(new Orc().run("valid_id").wait(0)).rejects.toThrow();
    await expect(new Orc().run("valid_id").wait(301)).rejects.toThrow();
  });

  it("returns the current status when the bounded wait times out", async () => {
    writeRunningRun("still_running");
    const started = Date.now();
    const status = await new Orc().run("still_running").wait(1);
    expect(status.state).toBe("running");
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("responds to a pending approval through the public SDK", async () => {
    writeRunningRun("approval_run");
    const traces = new JsonlAppender<TraceRecord>(runPaths("approval_run").traces);
    traces.append({
      t: "event",
      atMs: Date.now(),
      event: {
        kind: "approval-requested",
        approval: {
          id: "a_1",
          runId: "approval_run",
          seq: 0,
          toolName: "example.document-gate",
          input: {},
          actions: [
            {
              id: "revise",
              label: "Request revision",
              behavior: "deny",
              message: { label: "Instructions", required: true },
            },
          ],
          requestedAtMs: Date.now(),
        },
      },
    });
    traces.close();

    await new Orc().respond("approval_run", "a_1", {
      action: "revise",
      message: "Add rollback criteria",
    });
    expect(readControl("approval_run")).toMatchObject([
      {
        t: "approval",
        approvalId: "a_1",
        decision: {
          behavior: "deny",
          action: "revise",
          message: "Add rollback criteria",
        },
      },
    ]);
  });

  it("does not let direct response data retarget a different run or approval", async () => {
    writeRunningRun("trusted_run");
    writeApproval("trusted_run", "trusted_approval");
    writeRunningRun("spoofed_run");
    writeApproval("spoofed_run", "spoofed_approval");
    const spoofedDecision = {
      behavior: "allow",
      runId: "spoofed_run",
      approvalId: "spoofed_approval",
    } as unknown as Parameters<Orc["respond"]>[2];

    await new Orc().respond(
      "trusted_run",
      "trusted_approval",
      spoofedDecision,
    );

    expect(readControl("trusted_run")).toMatchObject([
      {
        t: "approval",
        approvalId: "trusted_approval",
        decision: { behavior: "allow" },
      },
    ]);
    expect(readControl("spoofed_run")).toEqual([]);
  });

  it("parses watch responses without allowing trusted IDs to be overwritten", async () => {
    writeRunningRun("watched_run");
    writeApproval("watched_run", "watched_approval");
    writeRunningRun("spoofed_watch_run");
    writeApproval("spoofed_watch_run", "spoofed_watch_approval");
    const events = new Orc().run("watched_run").watch(1);
    const iterator = events[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.kind).toBe("approval-requested");
    if (!next.value || next.value.kind !== "approval-requested") {
      throw new Error("expected approval event");
    }
    const spoofedDecision = {
      behavior: "allow",
      runId: "spoofed_watch_run",
      approvalId: "spoofed_watch_approval",
    } as unknown as Parameters<typeof next.value.respond>[0];

    await next.value.respond(spoofedDecision);
    await iterator.return?.();

    expect(readControl("watched_run")).toMatchObject([
      {
        t: "approval",
        approvalId: "watched_approval",
        decision: { behavior: "allow" },
      },
    ]);
    expect(readControl("spoofed_watch_run")).toEqual([]);
  });

  it("rejects malformed untyped watch responses at the operation boundary", async () => {
    writeRunningRun("parsed_watch_run");
    writeApproval("parsed_watch_run", "parsed_watch_approval");
    const events = new Orc().run("parsed_watch_run").watch(1);
    const iterator = events[Symbol.asyncIterator]();
    const next = await iterator.next();
    if (!next.value || next.value.kind !== "approval-requested") {
      throw new Error("expected approval event");
    }
    const malformedDecision = {
      behavior: "allow",
      message: 42,
    } as unknown as Parameters<typeof next.value.respond>[0];

    await expect(next.value.respond(malformedDecision)).rejects.toThrow();
    await iterator.return?.();

    expect(readControl("parsed_watch_run")).toEqual([]);
  });
});
