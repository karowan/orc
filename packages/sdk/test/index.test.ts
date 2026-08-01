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
    brief: "test",
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
      const run = await new Orc({ cwd: configDir }).launch({ programPath, brief: "finish immediately" });
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
});
