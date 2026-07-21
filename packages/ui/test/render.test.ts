import { describe, expect, it } from "vitest";
import type { JournalRecord } from "@orc/core";
import { projectStatus } from "@orc/core";
import { renderLivePage, renderReportHtml } from "../src/index.js";
import { makeJournal, makeManifest, makeTraces } from "./fixtures.js";

function fixture(opts: { settled?: boolean } = {}) {
  const runId = "r_demo_abc123";
  const manifest = makeManifest(runId);
  const journal = makeJournal();
  const traces = makeTraces(runId);
  if (opts.settled) {
    journal.push({ t: "done", seq: 2, status: "ok", resultSha: "sha2", attempt: 1 });
    journal.push({ t: "finish", status: "completed", resultSha: "shafinal" });
  }
  const status = projectStatus(manifest, journal, traces);
  return { manifest, status, traces };
}

describe("renderReportHtml (responsive design)", () => {
  it("renders the glance header: run id, name, state chip, stat tiles, gate counter", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    expect(html).toContain("r_demo_abc123");
    expect(html).toContain("demo run");
    expect(html).toContain('class="chip running"');
    // meta line (≥1200px): approval mode + writes + started
    expect(html).toContain("approval <b>manual</b>");
    expect(html).toContain("granted"); // writes granted
    expect(html).toContain("started ");
    // stat tiles: leaves done/total, elapsed, cost, gates
    expect(html).toMatch(/class="g-nv tnum">2\/3<\/span><span class="g-nk">leaves/);
    expect(html).toMatch(/data-elapsed-start="\d+"/);
    expect(html).toContain('class="g-nk">elapsed');
    expect(html).toMatch(/class="g-nv tnum gated">1<\/span><span class="g-nk">gates/);
    // the banner is gone; a compact gate COUNTER lives in the header
    expect(html).toContain('class="gate-count">1 GATE<');
    expect(html).not.toContain("pending approval"); // old banner copy removed
  });

  it("renders the segmented run bar with one segment per leaf", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    const segs = html.match(/class="g-seg[^"]*"/g) ?? [];
    expect(segs.length).toBe(status.leaves.length);
    expect(html).toContain('class="g-seg ok"');
    expect(html).toContain('class="g-seg gated"'); // gated running leaf
    expect(html).toContain('class="g-seg error"');
  });

  it("shows the latest feed event as a single glance line (no feed pane)", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    expect(html).toContain('class="g-last"');
    // the newest event in the fixture is the approval request
    expect(html).toContain("GATE <b>Bash</b> · agent#2");
    expect(html).not.toContain('class="feed"');
    expect(html).not.toContain('class="feed-scroll"');
  });

  it("includes meta refresh only when live", () => {
    const running = fixture();
    const live = renderReportHtml({ ...running, live: true });
    expect(live).toContain('http-equiv="refresh"');
    const done = fixture({ settled: true });
    expect(done.status.state).toBe("completed");
    const snapshot = renderReportHtml({ ...done, live: false });
    expect(snapshot).not.toContain('http-equiv="refresh"');
    expect(snapshot).toContain('class="chip completed"');
  });

  it("renders each pending approval as an inline strip under its leaf row plus the mobile dock", () => {
    const { manifest, status, traces } = fixture();
    expect(status.approvalsPending).toBe(1);
    const html = renderReportHtml({ manifest, status, traces, live: true });
    // the inline gate strip is attached to the gated leaf's row (seq 2)
    expect(html).toMatch(/class="strip-inline" data-approval="appr_1"/);
    expect(html).toContain('class="gate-tag">GATE');
    expect(html).toContain("Bash");
    expect(html).toContain("rm -rf ./dist");
    // small screens get the bottom dock for the same approval
    expect(html).toMatch(/class="dock" data-approval="appr_1"/);
    expect(html).toContain("agent#2 · Bash");
    expect(html).toContain("write leaf on @build@ci-box");
    // static page: the note, no working buttons
    expect(html).toContain("orc approvals");
    expect(html).not.toContain("orcApprove(");
    // the gated row gets the amber bar + hatch + diamond treatment + GATE tag
    expect(html).toContain('class="bar amber"');
    expect(html).toContain('class="hatch"');
    expect(html).toContain('class="diamond"');
    expect(html).toContain('class="c-row gated"');
  });

  it("escapes HTML in prompts and never emits script tags in the static report", () => {
    const { manifest, status, traces } = fixture();
    // Select the leaf whose prompt carries the XSS payload so it renders in the detail view.
    const html = renderReportHtml({ manifest, status, traces, live: false, selectedSeq: 1 });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders phase cards: header with counts + mini track, rows with bars, model, effort, dots", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    expect(html).toContain("agent#1");
    expect(html).toContain("agent#2");
    expect(html).toContain("agent#3");
    expect(html).toMatch(/class="bar ok" data-s="\d+" data-e="\d*" style="left:[\d.]+%;width:[\d.]+%"/);
    expect(html).toMatch(/class="bar error" data-s="\d+" data-e="\d*" style="left:[\d.]+%;width:[\d.]+%"/);
    expect(html).toMatch(/class="waterfall" data-range-start="\d+" data-running="1"/);
    // collapsible phase cards with done/total counters
    expect(html).toContain('data-key="phase-plan"');
    expect(html).toContain('data-key="phase-build"');
    expect(html).toMatch(/class="c-pn">plan<\/span><span class="c-pc tnum">1\/1</);
    expect(html).toMatch(/class="c-pn">build<\/span><span class="c-pc tnum">1\/2</);
    expect(html).toContain('class="chev"');
    // model shown in the row (shortened form) + effort pill
    expect(html).toContain("fable-5");
    expect(html).toMatch(/class="eff high"[^>]*>high</);
    expect(html).toContain('class="dot ok"');
    expect(html).toContain('class="dot error"');
    // host appears on the remote leaf's row
    expect(html).toContain("build@ci-box");
  });

  it("report shows the cost tile but no endless bottom detail stack", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    // The stacked per-leaf detail is gone; the detail view is the detail home.
    expect(html).not.toContain('class="static-detail"');
    expect(html).not.toContain("lane-block");
    // Header-level cost tile stays (mixed exact + estimated).
    expect(html).toContain(">~$0.13</span>");
    expect(html).toContain('class="g-nk">cost<');
  });

  it("uses durable spend from every retry attempt without double-counting revisions", () => {
    const { manifest, status, traces } = fixture();
    const journal: JournalRecord[] = [
      { t: "cost", seq: 1, attempt: 1, costUsd: 0.1234, costEstimated: false, atMs: 1 },
      { t: "cost", seq: 1, attempt: 2, costUsd: 0.1, costEstimated: false, atMs: 2 },
      { t: "cost", seq: 1, attempt: 2, costUsd: 0.25, costEstimated: false, atMs: 3 },
      { t: "cost", seq: 3, attempt: 1, costUsd: 0.0075, costEstimated: true, atMs: 4 },
    ];
    const html = renderReportHtml({ manifest, status, traces, journal, live: true });
    // attempt 1 ($0.1234) + latest durable attempt 2 cost ($0.25) +
    // estimated failed leaf ($0.0075) = $0.3809.
    expect(html).toContain(">~$0.38</span>");
  });

  it("surfaces a leaf's full record through the detail view (output, tools, usage)", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: false, selectedSeq: 1 });
    expect(html).toContain('class="detail"');
    expect(html).toContain('class="d-back"'); // back header (mobile) / drawer top (desktop)
    expect(html).toContain('class="dw-scroll"'); // detail body scrolls itself
    expect(html).toContain("claude-fable-5"); // full model in the runtime line
    expect(html).toContain("&quot;summary&quot;: &quot;planned&quot;"); // output json
    expect(html).toContain("Read");
    expect(html).toContain("Grep");
    expect(html).toContain("/src/app.ts"); // tool arg preview
    expect(html).toContain("line 1\nline 2"); // captured tool result
    expect(html).toContain("1.2k in");
    expect(html).toContain("340 out");
    expect(html).toContain("$0.12"); // claude exact
  });

  it("shows a failed leaf's error and estimated cost in its detail view", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: false, selectedSeq: 3 });
    expect(html).toContain("leaf exploded"); // error
    expect(html).toContain("~$0.01"); // codex estimated
  });

  it("keeps harness stderr OUT of the glance line and in the leaf's collapsed harness log", () => {
    const { manifest, status, traces } = fixture();
    // Without the leaf selected, the hlog lines appear nowhere.
    const noDetail = renderReportHtml({ manifest, status, traces, live: true });
    expect(noDetail).not.toContain("cache TTL");
    // With the leaf selected, they appear once (deduped ×2), collapsed by default.
    const withDetail = renderReportHtml({ manifest, status, traces, live: false, selectedSeq: 1 });
    expect(withDetail).toContain('<details class="hlog" data-key="hlog-1">');
    expect(withDetail).not.toContain('<details class="hlog" data-key="hlog-1" open');
    expect(withDetail).toContain("Harness log");
    expect(withDetail).toContain("3 lines · 1 dup");
    const dedup = withDetail.split("failed to renew cache TTL").length - 1;
    expect(dedup).toBe(1); // repeated line rendered once…
    expect(withDetail).toContain('class="cnt">×2'); // …with its count
  });

  it("detail shows newest 4 tool calls, older ones collapsed, output boxed+capped", () => {
    const { manifest, status, traces } = fixture();
    // Give leaf 1 seven tool calls: t1..t7, t7 newest.
    const leaf = traces.find((t) => t.t === "leaf" && t.seq === 1 && t.rev === 1) as { toolCalls: unknown[] };
    leaf.toolCalls = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i + 1}`, name: `Tool${i + 1}`, input: { n: i + 1 }, result: "ok", status: "ok",
      startMs: 1_700_000_000_000 + i * 1000, endMs: 1_700_000_000_000 + i * 1000 + 100,
    }));
    const html = renderReportHtml({ manifest, status, traces, live: false, selectedSeq: 1 });
    // Newest first: t7 appears before t6 in the visible list.
    expect(html.indexOf('data-key="tool-t7"')).toBeLessThan(html.indexOf('data-key="tool-t6"'));
    // The three oldest are behind the collapsed expander.
    expect(html).toContain("3 earlier calls");
    expect(html.indexOf("3 earlier calls")).toBeLessThan(html.indexOf('data-key="tool-t3"'));
    // Output is a capped box even for string outputs (rendered raw, not JSON-quoted).
    const strTraces = traces.map((t) =>
      t.t === "leaf" && t.seq === 1 && t.rev === 1 ? { ...t, output: "a plain text answer" } : t,
    );
    const strHtml = renderReportHtml({ manifest, status, traces: strTraces, live: false, selectedSeq: 1 });
    expect(strHtml).toContain('class="box capped">a plain text answer');
    expect(strHtml).not.toContain("&quot;a plain text answer&quot;");
  });

  it("uses the viewport layout: scrollable phase pane, viewport-locked shell", () => {
    const { manifest, status, traces } = fixture();
    const html = renderReportHtml({ manifest, status, traces, live: true });
    expect(html).toContain('class="scroll"'); // phase cards scroll region
    expect(html).toContain("height:100vh"); // page never grows
  });

  it("live page wires row-click detail, phase toggle, esc/close, optimistic approvals, and rAF bars", () => {
    const { manifest, status, traces } = fixture();
    const html = renderLivePage({ manifest, status, traces });
    expect(html).toMatch(/class="c-row[^"]*" data-seq="\d+"/);
    expect(html).toContain(".c-row[data-seq]"); // click handler targets rows
    expect(html).toContain(".c-ph[data-toggle]"); // phase headers collapse their card
    expect(html).toContain("orcCloseDrawer");
    expect(html).toContain('"/fragment"'); // detail via ?leaf= fragment fetch
    expect(html).toContain("selectedSeq");
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("EventSource");
    expect(html).toContain("layoutBars");
    expect(html).toContain("orcApprove");
  });

  it("opens the detail view for a selected leaf", () => {
    const { manifest, status, traces } = fixture();
    const html = renderLivePage({ manifest, status, traces, selectedSeq: 1 });
    expect(html).toContain('class="detail"');
    expect(html).toContain('class="d-title"');
    expect(html).toContain("d-close");
    expect(html).toContain('class="dw-meta"'); // runtime/cwd/idle
    // and the clicked row is marked selected
    expect(html).toContain('class="c-row sel"');
  });

  it("keeps bar geometry inside the run range", () => {
    const { manifest, status, traces } = fixture({ settled: true });
    const html = renderReportHtml({ manifest, status, traces, live: false });
    const widths = [...html.matchAll(/left:([\d.]+)%;width:([\d.]+)%/g)];
    expect(widths.length).toBeGreaterThanOrEqual(2);
    for (const [, left, width] of widths) {
      expect(Number(left)).toBeGreaterThanOrEqual(0);
      expect(Number(left) + Number(width)).toBeLessThanOrEqual(100.01);
    }
  });
});
