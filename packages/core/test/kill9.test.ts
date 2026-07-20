import { beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { readJournal, readResult, runPaths } from "../src/rundir.js";
import { makeFakeHarness, makeRegistry } from "./helpers/fake.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-kill9-"));
  process.env.ORC_HOME = home;
});

describe("kill -9 resume", () => {
  it("a SIGKILLed supervisor resumes to the same result with no double-dispatch of settled leaves", async () => {
    const log = path.join(home, "invocations.log");
    const registry = makeRegistry(makeFakeHarness());
    const manifest = await prepareRun(
      {
        programPath: path.join(__dirname, "fixtures", "lanes.orc.ts"),
        cwd: home,
        brief: "kill9 test",
      },
      registry,
    );

    // Child supervises with 300ms-latency leaves; we SIGKILL it mid-run.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "helpers", "child-runner.ts"), manifest.runId],
      { env: { ...process.env, ORC_HOME: home, ORC_FAKE_LOG: log }, stdio: "ignore", cwd: path.join(__dirname, "..", "..", "..") },
    );
    // Wait until at least one leaf has settled, then SIGKILL mid-run.
    const paths = runPaths(manifest.runId);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const j = readJournal(manifest.runId);
      const settled = j.filter((r) => r.t === "done").length;
      const finished = j.some((r) => r.t === "finish");
      if (settled >= 1 && !finished) break;
    }
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    void paths;

    const journalAfterKill = readJournal(manifest.runId);
    const settledBeforeKill = journalAfterKill.filter((r) => r.t === "done").map((r) => r.seq);
    expect(journalAfterKill.some((r) => r.t === "finish")).toBe(false); // died mid-run
    expect(settledBeforeKill.length).toBeGreaterThan(0); // and not before doing work

    // SIGKILL closes the holder pipe, so the kernel lock is released.
    const resumed = await superviseRun(
      manifest.runId,
      makeRegistry(makeFakeHarness({ invocationLog: log })),
    );
    expect(resumed.state).toBe("completed");
    const result = readResult(runPaths(manifest.runId), resumed.resultSha!) as Record<string, unknown>;
    expect(result.done).toBe(true);

    // No settled leaf ran twice: count invocations per seq across both processes.
    const counts = new Map<string, number>();
    for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
      const seq = line.split(":")[0];
      counts.set(seq, (counts.get(seq) ?? 0) + 1);
    }
    for (const seq of settledBeforeKill) {
      expect(counts.get(String(seq)), `seq ${seq} settled before kill`).toBe(1);
    }
  }, 120_000);
});
