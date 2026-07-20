import * as fs from "node:fs";
import { readJournal, readManifest, readTraces, runPaths } from "@orc/core/src/rundir.js";
import { statusForRun } from "@orc/core/src/status.js";
import { renderReportHtml } from "./render.js";

/**
 * Project current run state from disk and atomically write the static report
 * (tmp + rename) at runPaths(runId).report. Returns the report path.
 * The page auto-refreshes while the run is still running.
 */
export function writeReport(runId: string): string {
  const manifest = readManifest(runId);
  const journal = readJournal(runId);
  const traces = readTraces(runId);
  const status = statusForRun(runId);
  const html = renderReportHtml({ manifest, status, traces, journal, live: status.state === "running" });
  const target = runPaths(runId).report;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, target);
  return target;
}
