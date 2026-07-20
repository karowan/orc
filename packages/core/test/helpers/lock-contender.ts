import * as fs from "node:fs";
import { acquireLock, runPaths } from "../../src/rundir.js";

const [home, runId, readyFile, startFile, stopFile, resultFile] = process.argv.slice(2);
if (!home || !runId || !readyFile || !startFile || !stopFile || !resultFile) {
  throw new Error("lock-contender requires home, runId, ready, start, stop, and result paths");
}

process.env.ORC_HOME = home;
const waitFor = async (file: string) => {
  while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 5));
};
const writeResult = (result: string) => {
  const temp = `${resultFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, result);
  fs.renameSync(temp, resultFile);
};

fs.writeFileSync(readyFile, "");
await waitFor(startFile);
try {
  const lock = await acquireLock(runPaths(runId));
  writeResult("acquired");
  await waitFor(stopFile);
  await lock.release();
} catch (err) {
  writeResult(`rejected:${err instanceof Error ? err.message : String(err)}`);
}
