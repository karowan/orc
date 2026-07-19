/**
 * Child process for the kill-9 test: supervises an existing run with a SLOW
 * fake harness so the parent can SIGKILL it mid-flight.
 * argv: <runId>  env: ORC_HOME, ORC_FAKE_LOG
 */
import { superviseRun } from "../../src/supervisor.js";
import { makeFakeHarness, makeRegistry } from "./fake.js";

const runId = process.argv[2];
const registry = makeRegistry(
  makeFakeHarness({ latency: () => 600, invocationLog: process.env.ORC_FAKE_LOG }),
);
superviseRun(runId, registry)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
