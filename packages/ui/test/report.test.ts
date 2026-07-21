import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPaths } from "@orc/core";
import { writeReport } from "../src/index.js";
import { writeRunDir, XSS_PROMPT } from "./fixtures.js";

describe("writeReport", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ORC_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-ui-report-"));
    process.env.ORC_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("projects a fabricated run dir and writes report.html at the run path", () => {
    const run = writeRunDir("r_report_run1");
    const reportPath = writeReport(run.runId);
    expect(reportPath).toBe(runPaths(run.runId).report);
    expect(reportPath).toBe(path.join(run.dir, "report.html"));
    const html = fs.readFileSync(reportPath, "utf8");
    expect(html).toContain("r_report_run1");
    expect(html).toContain("agent#1");
    expect(html).toContain('class="gate-count">1 GATE<'); // header gate counter, not a banner
    expect(html).toContain("GATE <b>Bash</b> · agent#2"); // latest event in the glance line
    expect(html).not.toContain(XSS_PROMPT); // the unselected report never inlines prompts
    // no stray tmp file left behind
    expect(fs.existsSync(reportPath + ".tmp")).toBe(false);
  });

  it("marks a running run live (meta refresh) and a settled run static", () => {
    const running = writeRunDir("r_report_live");
    const liveHtml = fs.readFileSync(writeReport(running.runId), "utf8");
    expect(liveHtml).toContain('http-equiv="refresh"');

    const settled = writeRunDir("r_report_done", { settled: true });
    const doneHtml = fs.readFileSync(writeReport(settled.runId), "utf8");
    expect(doneHtml).not.toContain('http-equiv="refresh"');
    expect(doneHtml).toContain('class="chip completed"');
  });
});
