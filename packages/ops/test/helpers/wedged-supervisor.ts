/**
 * Child process for the hard-cancel test: takes the run's supervisor lock,
 * records its pid, ignores SIGTERM, and never settles — a wedged supervisor.
 * argv: <home> <runId> <readyFile>
 */
import * as fs from "node:fs";
import { acquireLock, runPaths, writeSupervisorPid } from "@karowanorg/orc-core";

const [home, runId, readyFile] = process.argv.slice(2);
if (!home || !runId || !readyFile) {
  throw new Error("wedged-supervisor requires home, runId, and ready paths");
}
process.env.ORC_HOME = home;
process.on("SIGTERM", () => {
  /* wedged: never cooperates */
});
const paths = runPaths(runId);
const lock = await acquireLock(paths);
writeSupervisorPid(paths, process.pid);
fs.writeFileSync(readyFile, "");
setInterval(() => undefined, 1_000);
void lock;
