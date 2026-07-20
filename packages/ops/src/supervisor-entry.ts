import { runSupervisorChild } from "./supervisor-run.js";

const runId = process.argv[2];
if (!runId) {
  process.stderr.write("orc supervisor: run id is required\n");
  process.exitCode = 1;
} else {
  try {
    await runSupervisorChild(runId);
  } catch (err) {
    process.stderr.write(`orc supervisor: ${String(err instanceof Error ? err.stack ?? err.message : err)}\n`);
    process.exitCode = 1;
  }
}
