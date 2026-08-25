import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  openApprovals,
  prepareRun,
  readControl,
  readTraces,
  runPaths,
  type JournalRecord,
  type Registry,
  type RunManifest,
  type TraceRecord,
} from "@karowanorg/orc-core";
import {
  cancel,
  respondApproval,
  resume,
  buildRegistry,
  runSupervisorChild,
  spawnDetachedSupervisor,
  type OpContext,
} from "@karowanorg/orc-ops";

const registry: Registry = {
  harnesses: new Map(),
  extensions: new Map(),
  defaultHarness: "none",
  executor: new Proxy({} as never, {
    get() {
      throw new Error("not used");
    },
  }),
};
const ctx: OpContext = { registry };

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.ORC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-controls-"));
  process.env.ORC_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRun(
  runId: string,
  options: { completed?: boolean; approvalId?: string; namedActions?: boolean } = {},
): void {
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
    defaultHarness: "none",
    createdAtMs: Date.now(),
    orcVersion: "0.1.0",
  };
  const journal: JournalRecord[] = options.completed
    ? [{ t: "finish", status: "completed", resultSha: "result" }]
    : [];
  const traces: TraceRecord[] = options.approvalId
    ? [
        {
          t: "event",
          atMs: Date.now(),
          event: {
            kind: "approval-requested",
            approval: {
              id: options.approvalId,
              runId,
              seq: 1,
              toolName: "Bash",
              input: { command: "echo ok" },
              ...(options.namedActions
                ? {
                    actions: [
                      { id: "approve", label: "Approve", behavior: "allow" as const },
                      {
                        id: "revise",
                        label: "Revise",
                        behavior: "deny" as const,
                        message: { label: "Instructions", required: true },
                      },
                    ],
                  }
                : {}),
              requestedAtMs: Date.now(),
            },
          },
        },
      ]
    : [];
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  fs.writeFileSync(
    paths.journal,
    journal.length
      ? journal.map((record) => JSON.stringify(record)).join("\n") + "\n"
      : "",
  );
  fs.writeFileSync(
    paths.traces,
    traces.length
      ? traces.map((record) => JSON.stringify(record)).join("\n") + "\n"
      : "",
  );
}

describe("control operations", () => {
  it("rejects unknown and stale controls before creating control.jsonl", async () => {
    await expect(cancel.handler({ runId: "missing" }, ctx)).rejects.toThrow();
    await expect(
      respondApproval.handler(
        { runId: "missing", approvalId: "a1", behavior: "allow" },
        ctx,
      ),
    ).rejects.toThrow();

    writeRun("completed", { completed: true });
    await expect(cancel.handler({ runId: "completed" }, ctx)).rejects.toThrow(
      "not running",
    );
    expect(fs.existsSync(runPaths("completed").control)).toBe(false);
  });

  it("only queues answers for approvals that are still open", async () => {
    writeRun("running", { approvalId: "pending" });
    await expect(
      respondApproval.handler(
        { runId: "running", approvalId: "stale", behavior: "deny" },
        ctx,
      ),
    ).rejects.toThrow("not pending");
    expect(fs.existsSync(runPaths("running").control)).toBe(false);

    await expect(
      respondApproval.handler(
        { runId: "running", approvalId: "pending", behavior: "allow" },
        ctx,
      ),
    ).resolves.toEqual({ enqueued: true });
    await expect(cancel.handler({ runId: "running" }, ctx)).resolves.toEqual({
      enqueued: true,
    });
    expect(readControl("running").map((message) => message.t)).toEqual([
      "approval",
      "cancel",
    ]);
  });

  it("derives named action behavior and enforces required messages", async () => {
    writeRun("named", { approvalId: "gate", namedActions: true });
    await expect(
      respondApproval.handler(
        { runId: "named", approvalId: "gate", action: "revise" },
        ctx,
      ),
    ).rejects.toThrow("requires a message");
    await expect(
      respondApproval.handler(
        { runId: "named", approvalId: "gate", action: "unknown", message: "x" },
        ctx,
      ),
    ).rejects.toThrow("not available");
    expect(fs.existsSync(runPaths("named").control)).toBe(false);

    await respondApproval.handler(
      {
        runId: "named",
        approvalId: "gate",
        action: "revise",
        message: "Add rollback criteria",
      },
      ctx,
    );
    expect(readControl("named")).toMatchObject([
      {
        t: "approval",
        decision: {
          behavior: "deny",
          action: "revise",
          message: "Add rollback criteria",
        },
      },
    ]);
  });
});

describe("detached resume preflight", () => {
  it("refreshes the durable report after a fast program reaches a gate", async () => {
    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "orc.config.mjs"),
      `export default {
  extensions: [{
    name: "wait_for_approval",
    readOnly: true,
    async execute(_input, context) {
      return context.requestApproval({
        runId: "",
        seq: 0,
        toolName: "Gate",
        input: {}
      });
    }
  }]
};
`,
    );
    const programPath = path.join(home, "gate.orc.ts");
    fs.writeFileSync(
      programPath,
      `export const meta = {
  graph: { nodes: [{ id: "gate", title: "Human gate", kind: "gate" }], edges: [] }
};
export default async ({ ext, phase }) =>
  phase("gate", () => ext.wait_for_approval({}));
`,
    );
    const built = await buildRegistry({ cwd: configDir });
    const manifest = await prepareRun(
      { programPath, cwd: home },
      built,
    );
    const child = runSupervisorChild(manifest.runId, configDir, async () => undefined);

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (openApprovals(readTraces(manifest.runId)).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const approval = openApprovals(readTraces(manifest.runId))[0];
      if (!approval) throw new Error("approval did not open");
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const report = fs.readFileSync(runPaths(manifest.runId).report, "utf8");
      expect(report).toContain('data-phase="gate"');
      expect(report).toContain("GATE · WAITING");

      await respondApproval.handler(
        {
          runId: manifest.runId,
          approvalId: approval.id,
          behavior: "allow",
        },
        { registry: built },
      );
      await child;
    } finally {
      const approval = openApprovals(readTraces(manifest.runId))[0];
      if (approval) {
        await respondApproval.handler(
          {
            runId: manifest.runId,
            approvalId: approval.id,
            behavior: "deny",
          },
          { registry: built },
        );
      }
      await child.catch(() => undefined);
    }
  });

  it("signals startup before a synchronous extension can block dispatch", async () => {
    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "orc.config.mjs"),
      `export default {
  extensions: [{
    name: "startup_check",
    readOnly: true,
    async execute() {
      if (!globalThis.__orcStartupSignalSent) throw new Error("startup was not signaled before dispatch");
      return { ok: true };
    }
  }]
};
`,
    );
    const programPath = path.join(home, "startup.orc.ts");
    fs.writeFileSync(
      programPath,
      `export default async ({ ext }) => ext.startup_check({});\n`,
    );
    const startupGlobal = globalThis as typeof globalThis & {
      __orcStartupSignalSent?: boolean;
    };
    startupGlobal.__orcStartupSignalSent = false;
    try {
      const built = await buildRegistry({ cwd: configDir });
      const manifest = await prepareRun(
        { programPath, cwd: home },
        built,
      );

      await expect(
        runSupervisorChild(manifest.runId, configDir, async (type) => {
          if (type === "orc-supervisor-ready") {
            startupGlobal.__orcStartupSignalSent = true;
          }
        }),
      ).resolves.toBeUndefined();
    } finally {
      delete startupGlobal.__orcStartupSignalSent;
    }
  });

  it("reports child startup errors instead of returning a false success", async () => {
    await expect(spawnDetachedSupervisor("missing")).rejects.toThrow(
      "manifest.json",
    );
  }, 15_000);

  it("does not report resumed before supervisor preflight succeeds", async () => {
    writeRun("tampered");
    fs.writeFileSync(runPaths("tampered").program, "not the pinned bundle");
    await expect(
      resume.handler({ runId: "tampered", wait: false }, ctx),
    ).rejects.toThrow("program bundle does not match manifest hash");
  }, 15_000);

  it("rejects completed runs before spawning", async () => {
    writeRun("done", { completed: true });
    await expect(
      resume.handler({ runId: "done", wait: false }, ctx),
    ).rejects.toThrow("already completed");
  });

  it("rejects a run owned by a live supervisor", async () => {
    writeRun("owned");
    const lock = await acquireLock(runPaths("owned"));
    try {
      await expect(
        resume.handler({ runId: "owned", wait: false }, ctx),
      ).rejects.toThrow("live supervisor");
    } finally {
      await lock.release();
    }
  });
});
