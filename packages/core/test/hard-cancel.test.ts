import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { livePgids, readJsonl, readSupervisorPid, runPaths } from "../src/rundir.js";
import type { Executor, PgidRecord, Proc } from "../src/contracts.js";
import { fakeExecutor, makeFakeHarness, makeRegistry } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-hard-cancel-"));
  process.env.ORC_HOME = home;
});

describe("supervisor liveness trail", () => {
  it("records its own pid durably after taking the lock", async () => {
    const registry = makeRegistry(makeFakeHarness());
    const manifest = await prepareRun(
      { programPath: FIX("retry.orc.ts"), cwd: home },
      registry,
    );
    const status = await superviseRun(manifest.runId, registry);
    expect(status.state).toBe("completed");
    expect(readSupervisorPid(runPaths(manifest.runId))).toBe(process.pid);
  });

  it("records leaf executor spawns in pgids.jsonl and releases them on exit", async () => {
    const fakeProc = (): Proc => ({
      stdin: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: Promise.resolve(0),
      kill: () => undefined,
      pid: 4242,
    });
    const executor: Executor = { ...fakeExecutor, spawn: () => fakeProc() };
    const registry = makeRegistry(makeFakeHarness(), {
      executor,
      extensions: new Map([
        [
          "lookup",
          {
            name: "lookup",
            readOnly: true,
            execute: async (_payload, ctx) => {
              // The context executor is the run-scoped recording wrapper.
              const proc = ctx.executor.spawn(["fake-leaf"]);
              await proc.exited;
              return { spawnedPid: proc.pid ?? null };
            },
          },
        ],
      ]),
    });
    const manifest = await prepareRun(
      { programPath: FIX("ext.orc.ts"), cwd: home },
      registry,
    );
    const status = await superviseRun(manifest.runId, registry);
    expect(status.state).toBe("completed");
    const paths = runPaths(manifest.runId);
    const records = readJsonl<PgidRecord>(paths.pgids);
    expect(records.map((record) => [record.t, record.pgid])).toEqual([
      ["spawn", 4242],
      ["exit", 4242],
    ]);
    expect(livePgids(paths)).toEqual([]);
  });
});
