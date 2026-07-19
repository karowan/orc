/**
 * orc monitor renderer — "terminal ops" design.
 *
 * Self-contained output: inline CSS, no external requests, all-monospace.
 * The pending-approvals banner is gone: every pending approval ("gate") renders
 * directly under the waterfall row of the leaf that raised it, and a right-hand
 * lane drawer (opened by clicking a row) carries the full leaf record.
 *
 * Dark is the designed theme; a light mapping is derived via tokens so
 * prefers-color-scheme still works. Font falls back to system mono to keep the
 * static report fully self-contained/offline.
 */
import type {
  ApprovalRequest,
  Json,
  LeafStatus,
  LeafTraceRecord,
  RunEventRecord,
  RunManifest,
  RunStatus,
  ToolCallTrace,
  TraceRecord,
} from "@orc/core/src/contracts.js";
import { latestLeafTraces, openApprovals } from "@orc/core/src/status.js";

// ---------------------------------------------------------------------------
// Escaping + formatting
// ---------------------------------------------------------------------------
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** mm:ss (or h:mm:ss) — the header elapsed clock. */
function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtStampClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
}
function fmtClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
function bound(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n… [truncated]" : s;
}

// ---------------------------------------------------------------------------
// Styles (tokens: dark default, derived light under prefers-color-scheme)
// ---------------------------------------------------------------------------
const CSS = `
:root{
  --bg:#0b0e13;--drawer:#090c10;--rowhover:#10141b;--track:#161c28;
  --border:#1e2530;--hair:#141924;--pill:#2a3342;
  --text:#c9d4e3;--bright:#e9eef6;--secondary:#8fa0b8;--muted:#5c6b80;--faint:#3b4757;
  --amber:#f5b944;--green:#3ddc84;--red:#ff5c5c;--blue:#6ab0ff;
  --amber-b:#f5b94466;--amber-bg:#f5b9441a;--amber-tint:#f5b9440d;--amber-tint2:#f5b94418;--amber-strip:#f5b94412;--amber-hatch:#f5b94433;
  --green-b:#3ddc8466;--green-bg:#3ddc841a;--red-b:#ff5c5c66;--red-bg:#ff5c5c1a;--blue-b:#6ab0ff55;
}
@media (prefers-color-scheme:light){:root{
  --bg:#f7f8fa;--drawer:#eef1f5;--rowhover:#e9edf3;--track:#dfe4ec;
  --border:#d4dae3;--hair:#e2e7ee;--pill:#c4ccd8;
  --text:#2b333f;--bright:#141a22;--secondary:#495568;--muted:#6b7789;--faint:#98a2b3;
  --amber:#b5820a;--green:#1a8f52;--red:#cf3838;--blue:#2f6fd6;
  --amber-b:#b5820a55;--amber-bg:#b5820a14;--amber-tint:#b5820a0d;--amber-tint2:#b5820a1a;--amber-strip:#b5820a12;--amber-hatch:#b5820a33;
  --green-b:#1a8f5255;--green-bg:#1a8f5214;--red-b:#cf383855;--red-bg:#cf383814;--blue-b:#2f6fd655;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
.mono{font-family:inherit}
.tnum{font-variant-numeric:tabular-nums}

.monitor{height:100vh;display:flex;flex-direction:column;background:var(--bg);overflow:hidden}
.hdr{padding:16px 20px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.hdr-row1{display:flex;align-items:center;gap:12px}
.logo{width:14px;height:14px;background:var(--amber);border-radius:3px;flex:none}
.run-id{font-size:15px;font-weight:700;color:var(--bright)}
.prog{font-size:12px;color:var(--muted)}
.grow{flex:1}
.chip{font-size:10.5px;font-weight:700;letter-spacing:.08em;padding:1px 8px;border-radius:3px;border:1px solid;text-transform:uppercase}
.chip.running{color:var(--amber);border-color:var(--amber-b)}
.chip.completed{color:var(--green);border-color:var(--green-b)}
.chip.failed{color:var(--red);border-color:var(--red-b)}
.chip.cancelled{color:var(--muted);border-color:var(--pill)}
.gate-count{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--bg);background:var(--amber);padding:2px 9px;border-radius:3px}
.cancel{font-size:11px;color:var(--muted);border:1px solid var(--border);padding:2px 9px;border-radius:3px;cursor:pointer;background:none;font-family:inherit}
.cancel:hover{color:var(--red);border-color:var(--red-b)}
.hdr-row2{display:flex;gap:18px;font-size:11px;color:var(--muted);flex-wrap:wrap}
.hdr-row2 b{color:var(--text);font-weight:400}
.hdr-row2 .ok-writes{color:var(--green)}

.split{flex:1;display:flex;align-items:stretch;min-height:0}
.wf-pane{flex:1;border-right:1px solid var(--border);min-width:0;min-height:0;display:flex;flex-direction:column}
.lanes{flex:1;overflow-y:auto;padding:10px 18px 14px}
.phase-hdr{font-size:10px;letter-spacing:.14em;color:var(--muted);padding:10px 0 5px;text-transform:uppercase}
.phase-hdr:first-child{padding-top:8px}

.row{display:grid;grid-template-columns:190px 175px 1fr 58px 12px;gap:9px;align-items:center;padding:4px 0;border-bottom:1px solid var(--hair);cursor:pointer}
.row:hover{background:var(--rowhover)}
.row.gated{background:var(--amber-tint);border-bottom:none}
.row.gated:hover{background:var(--amber-tint2)}
.row.queued{opacity:.55;cursor:default}
.row.sel{outline:1px solid var(--amber)}
.row.sel .seq{color:var(--amber)}
.row.sel .lbl-id{color:var(--bright)}
.cell-lbl{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.seq{color:var(--muted)}
.lbl-id{color:var(--text)}
.cell-rt{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden}
.eff{border-radius:2px;padding:0 4px;font-size:9.5px;font-weight:700;border:1px solid;text-transform:uppercase}
.eff.low{color:var(--muted);border-color:var(--pill)}
.eff.med{color:var(--blue);border-color:var(--blue-b)}
.eff.high{color:var(--amber);border-color:var(--amber-b);background:var(--amber-bg)}
.trk{position:relative;height:8px}
.trk .base{position:absolute;inset:3px 0;background:var(--track);border-radius:1px}
.bar{position:absolute;top:0;bottom:0;border-radius:1px}
.bar.ok{background:var(--green)}
.bar.running{background:var(--amber)}
.bar.error{background:var(--red)}
.bar.amber{background:var(--amber)}
.hatch{position:absolute;top:0;bottom:0;border-radius:1px;background:repeating-linear-gradient(45deg,var(--amber-hatch) 0 4px,transparent 4px 8px)}
.diamond{position:absolute;top:-2px;width:11px;height:11px;background:var(--amber);transform:rotate(45deg);box-shadow:0 0 10px var(--amber-b);border:1px solid var(--bg)}
@media (prefers-reduced-motion:no-preference){.bar,.hatch{transition:left .25s ease,width .25s ease}}
.bar.running,.hatch,.diamond{transition:none}
.cell-dur{font-size:11px;color:var(--muted);text-align:right}
.cell-dur.run{color:var(--amber)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--green)}
.dot.running{background:var(--amber)}
.dot.error{background:var(--red)}
.dot.pending{border:1px solid var(--pill)}

.strip{display:flex;align-items:center;gap:12px;padding:7px 10px;margin:0 0 2px;background:var(--amber-strip);border-left:2px solid var(--amber)}
.gate-tag{font-size:9.5px;font-weight:700;letter-spacing:.1em;color:var(--bg);background:var(--amber);padding:1px 6px;border-radius:2px;flex:none}
.strip .tool{font-size:11.5px;color:var(--bright);font-weight:500;flex:none}
.strip .arg{font-size:11.5px;color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.strip .waiting{font-size:10px;color:var(--muted);flex:none}
.abtn{font-size:10.5px;font-weight:700;letter-spacing:.06em;padding:2px 10px;border-radius:3px;cursor:pointer;border:1px solid;background:none;font-family:inherit;flex:none}
.abtn.allow{color:var(--green);border-color:var(--green-b)}
.abtn.allow:hover{background:var(--green-bg)}
.abtn.deny{color:var(--red);border-color:var(--red-b)}
.abtn.deny:hover{background:var(--red-bg)}
.strip .resolving{font-size:10.5px;color:var(--muted);flex:none}
.add{color:var(--green)}
.del{color:var(--red)}

.feed{flex:none;height:168px;border-top:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg)}
.feed-hdr{flex:none;display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.14em;color:var(--muted);padding:8px 18px 5px;text-transform:uppercase}
.feed-scroll{flex:1;overflow-y:auto;padding:0 18px 10px;display:flex;flex-direction:column;gap:1px}
.feed-scroll .feed-row{flex:none}
.feed-n{font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--muted);background:var(--track);padding:0 6px;border-radius:7px}
.feed-row{--fc:var(--faint);display:grid;grid-template-columns:66px 52px 1fr;gap:10px;align-items:baseline;padding:2.5px 0 2.5px 9px;border-left:2px solid var(--fc);border-radius:0 2px 2px 0}
.feed-row.gate{--fc:var(--amber);background:var(--amber-tint)}
.feed-row.allow{--fc:var(--green)}
.feed-row.deny{--fc:var(--red)}
.feed-row.phase{--fc:var(--blue)}
.feed-row.log{--fc:var(--pill)}
.fts{font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.ftag{font-size:8.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--fc);white-space:nowrap}
.fmsg{font-size:11px;color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmsg b{color:var(--bright);font-weight:700}
.fmsg .fdim{color:var(--muted)}

.drawer{width:400px;flex:none;background:var(--drawer);display:flex;flex-direction:column;min-height:0;box-shadow:-12px 0 28px rgba(0,0,0,.4)}
.dw-title{flex:none;display:flex;align-items:center;gap:10px;padding:13px 18px 11px;border-bottom:1px solid var(--hair)}
.dw-scroll{flex:1;overflow-y:auto;padding:13px 18px 18px;display:flex;flex-direction:column;gap:13px}
.dw-title .name{font-size:13px;font-weight:700;color:var(--bright)}
.dw-title .name .seq{color:var(--amber)}
.dw-close{font-size:13px;color:var(--muted);cursor:pointer;line-height:1;background:none;border:none;font-family:inherit}
.dw-close:hover{color:var(--text)}
.dw-meta{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:11px}
.dw-meta .k{color:var(--faint)}
.dw-meta .v{color:var(--secondary)}
.dw-gate{border:1px solid var(--amber-b);border-left:2px solid var(--amber);background:var(--amber-tint);padding:11px 13px;display:flex;flex-direction:column;gap:10px}
.dw-gate .dw-title{padding:0;border-bottom:none}
.dw-gate .wants{font-size:11px;color:var(--secondary)}
.dw-gate .wants b{color:var(--bright);font-weight:700}
.box{font-size:11px;color:var(--secondary);background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:8px 11px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.box.capped{max-height:220px;overflow-y:auto}
details.hlog>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
details.hlog>summary::-webkit-details-marker{display:none}
details.hlog>summary::before{content:"▸";color:var(--faint);font-size:9px}
details.hlog[open]>summary::before{content:"▾"}
details.hlog .box{margin-top:6px;max-height:220px;overflow-y:auto}
details.hlog .dw-tools{margin-top:4px}
.hl-line{display:flex;gap:8px;align-items:baseline}
.hl-line .cnt{color:var(--red);font-weight:700;flex:none}
.dw-gate .actions{display:flex;gap:9px}
.dw-allow{flex:1;text-align:center;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--bg);background:var(--green);padding:5px 0;border-radius:3px;cursor:pointer;border:none;font-family:inherit}
.dw-allow:hover{filter:brightness(1.1)}
.dw-deny{flex:1;text-align:center;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--red);border:1px solid var(--red-b);padding:4px 0;border-radius:3px;cursor:pointer;background:none;font-family:inherit}
.dw-deny:hover{background:var(--red-bg)}
.dw-sec{display:flex;flex-direction:column;gap:5px}
.dw-sec-hdr{font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
.dw-tools{display:flex;flex-direction:column}
.dw-tool{display:flex;flex-direction:column;padding:5px 0;border-bottom:1px solid var(--hair)}
.dw-tool:last-child{border-bottom:none}
.dw-tool-head{display:flex;align-items:center;gap:8px;cursor:pointer}
.dw-tool-head .g{width:6px;height:6px;border-radius:50%;flex:none}
.dw-tool-head .g.ok{background:var(--green)}
.dw-tool-head .g.error{background:var(--red)}
.dw-tool-head .g.running{background:var(--amber);border-radius:0;transform:rotate(45deg)}
.dw-tool-head .tn{font-size:11px;color:var(--text);flex:none}
.dw-tool.blocked .dw-tool-head .tn{color:var(--amber)}
.dw-tool-head .ta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dw-tool-head .td{font-size:10px;color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.dw-tool.blocked .dw-tool-head .td{color:var(--amber)}
.dw-tool-head .chev{color:var(--faint);font-size:9px;flex:none;transition:transform .15s}
.dw-tool.open .dw-tool-head .chev{transform:rotate(90deg)}
.dw-tool-body{display:none;flex-direction:column;gap:6px;padding:7px 0 2px}
.dw-tool.open .dw-tool-body{display:flex}
.dw-tool-body .lbl{font-size:9.5px;letter-spacing:.1em;color:var(--faint);text-transform:uppercase}
.dw-tool-body .box{max-height:220px;overflow:auto}
.dw-usage{display:flex;gap:16px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);padding-top:9px}
.dw-usage .sess{color:var(--faint);margin-left:auto}
.static-note{font-size:11px;color:var(--muted);margin-top:2px}

/* index page */
table{border-collapse:collapse;width:100%;font-size:12px}
th{text-align:left;color:var(--muted);font-size:11px;padding:5px 12px 5px 0;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.06em}
td{padding:5px 12px 5px 0;border-bottom:1px solid var(--hair)}
main{max-width:1000px;margin:0 auto;padding:24px 20px}
h1{font-size:16px;font-weight:700;color:var(--bright)}
`.trim();

function page(title: string, body: string, opts: { refresh?: boolean; script?: string } = {}): string {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="2">\n` : "";
  const script = opts.script ? `\n<script>${opts.script}</script>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
${body}${script}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Run body
// ---------------------------------------------------------------------------
export interface RunView {
  manifest: RunManifest;
  status: RunStatus;
  traces: TraceRecord[];
  /** true = live server page (working gate buttons, drawer, SSE). */
  interactive: boolean;
  /** seq of the leaf whose lane drawer is open (undefined = closed). */
  selectedSeq?: number;
  /** clock override for deterministic tests. */
  nowMs?: number;
}

function effortClass(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "low") return "low";
  if (effort === "medium" || effort === "med") return "med";
  return "high"; // high/xhigh/max/ultra
}
function effortPill(effort: string | undefined): string {
  const cls = effortClass(effort);
  if (!cls) return "";
  return `<span class="eff ${cls}">${escapeHtml(effort!)}</span>`;
}

function toolArgPreview(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "object" && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "pattern", "url", "query", "notebook_path", "old_string"]) {
      if (typeof o[k] === "string") return String(o[k]);
    }
  }
  return typeof input === "string" ? input : JSON.stringify(input);
}

interface CostRollup {
  total: number;
  anyEstimated: boolean;
  anyExact: boolean;
  present: boolean;
}
function rollupCost(detail: Map<number, LeafTraceRecord>): CostRollup {
  let total = 0;
  let anyEstimated = false;
  let anyExact = false;
  let present = false;
  for (const tr of detail.values()) {
    if (tr.costUsd === undefined) continue;
    present = true;
    total += tr.costUsd;
    if (tr.costEstimated) anyEstimated = true;
    else anyExact = true;
  }
  return { total, anyEstimated, anyExact, present };
}
function fmtCostRollup(c: CostRollup): string {
  const prefix = c.anyEstimated ? "~" : "";
  const suffix = c.anyEstimated && c.anyExact ? " (incl. est)" : c.anyEstimated ? " est" : "";
  return `${prefix}$${c.total.toFixed(2)}${suffix}`;
}

export function renderRunBody(view: RunView): string {
  const { manifest, status, traces } = view;
  const nowMs = view.nowMs ?? Date.now();
  const detail = latestLeafTraces(traces);
  const approvals = openApprovals(traces);
  const gatesBySeq = new Map<number, ApprovalRequest[]>();
  for (const a of approvals) {
    const arr = gatesBySeq.get(a.seq) ?? [];
    arr.push(a);
    gatesBySeq.set(a.seq, arr);
  }
  const events = traces.filter((r): r is RunEventRecord => r.t === "event");
  const cost = rollupCost(detail);

  const drawer =
    view.selectedSeq !== undefined && status.leaves.some((l) => l.seq === view.selectedSeq)
      ? renderDrawer(view, detail, gatesBySeq, nowMs)
      : "";

  return `<div class="monitor">
${renderHeader(manifest, status, approvals.length, cost, view.interactive, nowMs)}
<div class="split">
<div class="wf-pane">
<div class="lanes">
${renderWaterfall(status, detail, gatesBySeq, view, nowMs)}
</div>
${renderFeed(events)}
</div>
${drawer}
</div>
</div>`;
}

function renderHeader(
  manifest: RunManifest,
  status: RunStatus,
  gateCount: number,
  cost: CostRollup,
  interactive: boolean,
  nowMs: number,
): string {
  const name = manifest.name ?? manifest.programPath.split("/").pop() ?? "program";
  const elapsed = fmtElapsed((status.endedAtMs ?? nowMs) - status.startedAtMs);
  const gates =
    gateCount > 0
      ? `<span class="gate-count">${gateCount} GATE${gateCount === 1 ? "" : "S"} OPEN</span>`
      : "";
  const cancel = interactive && status.state === "running" ? `<button class="cancel" onclick="orcCancel()">CANCEL</button>` : "";
  const budgetPart = manifest.budgetUsd !== undefined ? ` / $${manifest.budgetUsd.toFixed(2)} budget` : "";
  const costPart =
    cost.present || budgetPart
      ? `<span>cost <b>${cost.present ? fmtCostRollup(cost) : "$0.00"}${budgetPart}</b></span>`
      : "";
  return `<div class="hdr">
<div class="hdr-row1">
<span class="logo"></span>
<span class="run-id">${escapeHtml(status.runId)}</span>
<span class="prog">${escapeHtml(name)}</span>
<span class="chip ${status.state}">${status.state}</span>
<span class="grow"></span>
${gates}${cancel}
</div>
<div class="hdr-row2">
<span>approval <b>${escapeHtml(status.approvalMode)}</b></span>
<span>writes ${status.allowWrites ? '<b class="ok-writes">granted</b>' : "<b>read-only</b>"}</span>
<span>started <b>${fmtStampClock(status.startedAtMs)}</b></span>
<span class="grow"></span>
<span>${status.ok} ok · ${status.failed} failed · ${status.running} running / ${status.totalCalls}</span>
<span>elapsed <b class="tnum">${elapsed}</b></span>
${costPart}
</div>
</div>`;
}

function renderWaterfall(
  status: RunStatus,
  detail: Map<number, LeafTraceRecord>,
  gatesBySeq: Map<number, ApprovalRequest[]>,
  view: RunView,
  nowMs: number,
): string {
  const rangeStart = status.startedAtMs;
  const rangeEnd = Math.max(status.endedAtMs ?? nowMs, rangeStart + 1);
  const span = Math.max(rangeEnd - rangeStart, 1);
  const pct = (ms: number) => Math.min(Math.max(((ms - rangeStart) / span) * 100, 0), 100);

  // group leaves by phase, preserving order
  const rows: string[] = [];
  let prevPhase: string | undefined;
  let phaseLeaves: LeafStatus[] = [];
  const flushPhase = () => {
    if (phaseLeaves.length === 0) return;
    const label = prevPhase ?? "";
    if (label) rows.push(`<div class="phase-hdr">${escapeHtml(label)} · ${phaseLeaves.length} ${phaseLeaves.length === 1 ? "leaf" : "leaves"}</div>`);
    for (const leaf of phaseLeaves) rows.push(renderLeafRow(leaf, detail.get(leaf.seq), gatesBySeq.get(leaf.seq), view, rangeStart, rangeEnd, pct, nowMs));
    phaseLeaves = [];
  };
  for (const leaf of status.leaves) {
    if (leaf.phase !== prevPhase) {
      flushPhase();
      prevPhase = leaf.phase;
    }
    phaseLeaves.push(leaf);
  }
  flushPhase();

  const content = rows.length ? rows.join("\n") : `<div class="feed-line">no calls yet</div>`;
  const anyRunning = status.leaves.some((l) => l.status === "running");
  return `<section class="waterfall" data-range-start="${rangeStart}" data-running="${anyRunning ? 1 : 0}">
${content}
</section>`;
}

function renderLeafRow(
  leaf: LeafStatus,
  tr: LeafTraceRecord | undefined,
  gates: ApprovalRequest[] | undefined,
  view: RunView,
  rangeStart: number,
  rangeEnd: number,
  pct: (ms: number) => number,
  nowMs: number,
): string {
  const gated = !!gates && gates.length > 0 && leaf.status === "running";
  const queued = leaf.status === "pending" && leaf.startMs === undefined;
  const sel = view.selectedSeq === leaf.seq;
  const cls = ["row", gated ? "gated" : "", queued ? "queued" : "", sel ? "sel" : ""].filter(Boolean).join(" ");

  const idLabel = leaf.id ? ` <span class="lbl-id">${escapeHtml(leaf.id)}</span>` : "";
  const label = `<span class="seq">${leaf.kind}#${leaf.seq}</span>${idLabel}`;

  const harness = leaf.harness ?? tr?.harness;
  const model = tr?.model ? tr.model.replace(/^claude-/, "").replace(/-sol$|-\d+$/, (m) => m) : undefined;
  const rt = queued
    ? "queued"
    : [harness, model].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ") +
      (tr?.reasoningEffort ? " " + effortPill(tr.reasoningEffort) : "") +
      (leaf.host ?? tr?.host ? ` <span class="seq">@${escapeHtml((leaf.host ?? tr?.host)!)}</span>` : "");

  // track
  const start = leaf.startMs ?? tr?.startMs;
  const end = leaf.endMs ?? tr?.endMs;
  let track = `<span class="base"></span>`;
  let dur = "—";
  if (start !== undefined) {
    if (gated) {
      const blockMs = gates![0].requestedAtMs;
      const s = pct(start);
      const b = pct(blockMs);
      track += `<span class="bar amber" data-s="${start}" data-e="${blockMs}" style="left:${s.toFixed(2)}%;width:${Math.max(b - s, 0).toFixed(2)}%"></span>`;
      track += `<span class="hatch" data-s="${blockMs}" data-e="" style="left:${b.toFixed(2)}%;width:${Math.max(pct(nowMs) - b, 0).toFixed(2)}%"></span>`;
      track += `<span class="diamond" data-diamond="${blockMs}" style="left:${b.toFixed(2)}%"></span>`;
      dur = `<span class="dur-v" data-s="${start}" data-e="">${fmtDuration(nowMs - start)}</span>…`;
    } else {
      const running = leaf.status === "running";
      const e = running ? nowMs : (end ?? start);
      const s = pct(start);
      const w = Math.max(pct(e) - s, 0.5);
      const dataE = running ? "" : String(end ?? start);
      track += `<span class="bar ${leaf.status}" data-s="${start}" data-e="${dataE}" style="left:${s.toFixed(2)}%;width:${w.toFixed(2)}%"></span>`;
      dur = `<span class="dur-v" data-s="${start}" data-e="${dataE}">${fmtDuration(e - start)}</span>${running ? "…" : ""}`;
    }
  }
  const dotCls = leaf.status === "pending" ? "pending" : leaf.status;
  const durCls = leaf.status === "running" ? "cell-dur run" : "cell-dur";

  const row = `<div class="${cls}"${queued ? "" : ` data-seq="${leaf.seq}"`} data-key="row-${leaf.seq}">
<div class="cell-lbl">${label}</div>
<div class="cell-rt">${rt}</div>
<div class="trk">${track}</div>
<div class="${durCls} tnum">${dur}</div>
<div><span class="dot ${dotCls}"></span></div>
</div>`;

  const strips = gated ? gates!.map((g) => renderGateStrip(g, view.interactive, nowMs)).join("\n") : "";
  return row + (strips ? "\n" + strips : "");
}

function renderGateStrip(a: ApprovalRequest, interactive: boolean, nowMs: number): string {
  const arg = escapeHtml(bound(toolArgPreview(a.input), 200).replace(/\n/g, " "));
  const waiting = fmtDuration(nowMs - a.requestedAtMs);
  const actions = interactive
    ? `<button class="abtn allow" onclick="orcApprove('${escapeHtml(a.id)}','allow')">ALLOW</button><button class="abtn deny" onclick="orcApprove('${escapeHtml(a.id)}','deny')">DENY</button>`
    : `<span class="resolving">respond with orc approvals</span>`;
  return `<div class="strip" data-approval="${escapeHtml(a.id)}">
<span class="gate-tag">GATE</span>
<span class="tool">${escapeHtml(a.toolName)}</span>
<span class="arg">${arg}</span>
<span class="waiting">waiting ${waiting}</span>
<span class="appr-actions">${actions}</span>
</div>`;
}

/** One feed row: a color class, a short uppercase tag, and the message HTML. */
function feedRow(e: RunEventRecord): { cls: string; tag: string; msg: string } {
  switch (e.event.kind) {
    case "phase":
      return { cls: "phase", tag: "phase", msg: `→ <b>${escapeHtml(e.event.name)}</b>` };
    case "approval-requested":
      return {
        cls: "gate",
        tag: "gate",
        msg: `<b>${escapeHtml(e.event.approval.toolName)}</b> <span class="fdim">agent#${e.event.approval.seq}</span>`,
      };
    case "approval-resolved": {
      const allow = e.event.decision.behavior === "allow";
      return {
        cls: allow ? "allow" : "deny",
        tag: allow ? "allow" : "deny",
        msg: `${allow ? "allowed" : "denied"} <span class="fdim">by ${escapeHtml(e.event.by)}</span>`,
      };
    }
    case "denied":
      return {
        cls: "deny",
        tag: "deny",
        msg: `<b>${escapeHtml(e.event.toolName)}</b> <span class="fdim">agent#${e.event.seq}</span>`,
      };
    case "log":
    default:
      return { cls: "log", tag: "log", msg: escapeHtml(e.event.kind === "log" ? e.event.message : "") };
  }
}

function renderFeed(events: RunEventRecord[]): string {
  if (events.length === 0) return "";
  // The feed is a fixed-height dock with its own scrollbar (newest on top), so
  // it can carry real history without ever growing the page.
  const rows = [...events]
    .reverse()
    .slice(0, 200)
    .map((e) => {
      const { cls, tag, msg } = feedRow(e);
      return `<div class="feed-row ${cls}"><span class="fts tnum">${fmtClock(e.atMs)}</span><span class="ftag">${tag}</span><span class="fmsg">${msg}</span></div>`;
    })
    .join("\n");
  return `<div class="feed">
<div class="feed-hdr">Feed<span class="feed-n">${events.length}</span></div>
<div class="feed-scroll">
${rows}
</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Lane drawer
// ---------------------------------------------------------------------------
function renderDrawer(
  view: RunView,
  detail: Map<number, LeafTraceRecord>,
  gatesBySeq: Map<number, ApprovalRequest[]>,
  nowMs: number,
): string {
  const leaf = view.status.leaves.find((l) => l.seq === view.selectedSeq)!;
  const gates = gatesBySeq.get(leaf.seq) ?? [];
  const gated = gates.length > 0 && leaf.status === "running";
  const statusTag = gated ? "gated" : leaf.status;
  const statusClass = gated ? "running" : leaf.status === "pending" ? "cancelled" : leaf.status;
  const close = view.interactive ? `<button class="dw-close" onclick="orcCloseDrawer()">✕</button>` : "";
  return `<div class="drawer">
<div class="dw-title">
<span class="name"><span class="seq">${leaf.kind}#${leaf.seq}</span>${leaf.id ? " " + escapeHtml(leaf.id) : ""}</span>
<span class="chip ${statusClass}">${escapeHtml(statusTag)}</span>
<span class="grow"></span>${close}
</div>
<div class="dw-scroll">
${renderLaneContent(view, leaf, detail, gates, nowMs)}
</div>
</div>`;
}

/** The inner sections shared by the live drawer and the report snapshot. */
function renderLaneContent(
  view: RunView,
  leaf: LeafStatus,
  detail: Map<number, LeafTraceRecord>,
  gates: ApprovalRequest[],
  nowMs: number,
): string {
  const tr = detail.get(leaf.seq);
  const gated = gates.length > 0 && leaf.status === "running";
  const meta: string[] = [];
  const harness = leaf.harness ?? tr?.harness;
  const model = tr?.model;
  meta.push(
    `<span class="k">runtime</span><span class="v">${[harness, model].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ")}${tr?.reasoningEffort ? " " + effortPill(tr.reasoningEffort) : ""}</span>`,
  );
  if (leaf.startMs) {
    const rt = leaf.status === "running" ? ` · running ${fmtDuration(nowMs - leaf.startMs)}` : leaf.endMs ? ` · ${fmtDuration(leaf.endMs - leaf.startMs)}` : "";
    meta.push(`<span class="k">started</span><span class="v">${fmtStampClock(leaf.startMs)}${rt}</span>`);
  }
  const host = leaf.host ?? tr?.host;
  meta.push(`<span class="k">cwd</span><span class="v">${escapeHtml(tr?.cwd ?? view.manifest.cwd)} · ${host ? "@" + escapeHtml(host) : "local"}</span>`);
  const idle = view.manifest.idleTimeoutMs === false ? "disabled" : `${Math.round((view.manifest.idleTimeoutMs as number) / 60000)}m`;
  meta.push(`<span class="k">idle timeout</span><span class="v">${idle}</span>`);

  const gateBlock = gated ? renderDrawerGate(gates[0], view.interactive) : "";

  const promptSec = tr?.prompt
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Prompt</div><div class="box capped">${escapeHtml(bound(tr.prompt, 6000))}</div></div>`
    : "";

  // A string output renders raw (not as an escaped JSON literal); either way
  // the box is capped and scrolls itself so a long answer can't stretch the drawer.
  const outputSec =
    tr?.output !== undefined
      ? `<div class="dw-sec"><div class="dw-sec-hdr">Output</div><div class="box capped">${escapeHtml(bound(typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output, null, 2), 16384))}</div></div>`
      : "";
  const errSec = leaf.error ?? tr?.error
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Error</div><div class="box capped" style="color:var(--red)">${escapeHtml(bound((leaf.error ?? tr?.error)!, 4096))}</div></div>`
    : "";

  // Newest tool calls first; only the latest 4 visible, the rest behind a
  // collapsed expander so a chatty leaf doesn't swamp the drawer.
  const tools = [...(tr?.toolCalls ?? [])].reverse();
  const visibleTools = tools.slice(0, 4);
  const olderTools = tools.slice(4);
  const toolsSec = tools.length
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Tool calls · ${tools.length}</div><div class="dw-tools">${visibleTools.map((c) => renderDrawerTool(c)).join("")}</div>${
        olderTools.length
          ? `<details class="hlog" data-key="tools-more-${leaf.seq}"><summary>${olderTools.length} earlier call${olderTools.length === 1 ? "" : "s"}</summary><div class="dw-tools">${olderTools.map((c) => renderDrawerTool(c)).join("")}</div></details>`
          : ""
      }</div>`
    : "";

  const usage: string[] = [];
  if (tr?.tokensIn !== undefined) usage.push(`${fmtTokens(tr.tokensIn)} in`);
  if (tr?.tokensOut !== undefined) usage.push(`${fmtTokens(tr.tokensOut)} out`);
  if (tr?.costUsd !== undefined) usage.push(`${tr.costEstimated ? "~" : ""}$${tr.costUsd.toFixed(2)}`);
  const usageSec = usage.length || tr?.sessionId
    ? `<div class="dw-usage">${usage.map((u) => `<span>${u}</span>`).join("")}${tr?.sessionId ? `<span class="sess">session ${escapeHtml(tr.sessionId.slice(0, 8))}</span>` : ""}</div>`
    : "";

  return `<div class="dw-meta">${meta.join("")}</div>
${gateBlock}${promptSec}${outputSec}${errSec}${toolsSec}${renderHarnessLog(view, leaf.seq)}${usageSec}`;
}

/**
 * The leaf's own harness stderr/tracing, collapsed by default. Identical lines
 * are deduped with a ×N count so a repeating benign error (e.g. codex's cache
 * TTL renew spam) reads as one line, not hundreds.
 */
function renderHarnessLog(view: RunView, seq: number): string {
  const lines = view.traces.filter(
    (r): r is Extract<TraceRecord, { t: "hlog" }> => r.t === "hlog" && r.seq === seq,
  );
  if (lines.length === 0) return "";
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.message, (counts.get(l.message) ?? 0) + 1);
  const dupes = lines.length - counts.size;
  const shown = [...counts.entries()].slice(0, 40);
  const body = shown
    .map(
      ([m, n]) =>
        `<div class="hl-line"><span class="m">${escapeHtml(bound(m, 500))}</span>${n > 1 ? `<span class="cnt">×${n}</span>` : ""}</div>`,
    )
    .join("");
  const more = counts.size > 40 ? `<div class="hl-line"><span class="m">… ${counts.size - 40} more distinct lines in traces.jsonl</span></div>` : "";
  return `<details class="hlog" data-key="hlog-${seq}"><summary>Harness log<span class="feed-n">${lines.length} line${lines.length === 1 ? "" : "s"}${dupes > 0 ? ` · ${dupes} dup` : ""}</span></summary><div class="box">${body}${more}</div></details>`;
}

function renderDrawerGate(a: ApprovalRequest, interactive: boolean): string {
  const raw = typeof a.input === "string" ? a.input : toolArgPreview(a.input) || JSON.stringify(a.input, null, 2);
  // color diff-like lines
  const boxHtml = escapeHtml(bound(raw, 4000))
    .split("\n")
    .map((l) => (l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") || l.startsWith("−") ? `<span class="del">${l}</span>` : l))
    .join("\n");
  const actions = interactive
    ? `<div class="actions"><button class="dw-allow appr-actions-btn" onclick="orcApprove('${escapeHtml(a.id)}','allow')">ALLOW</button><button class="dw-deny" onclick="orcApprove('${escapeHtml(a.id)}','deny')">DENY</button></div>`
    : `<div class="static-note">respond with <b>orc approvals</b></div>`;
  return `<div class="dw-gate" data-approval="${escapeHtml(a.id)}">
<div class="dw-title"><span class="gate-tag">GATE</span><span class="wants">wants <b>${escapeHtml(a.toolName)}</b> · outside auto-approved scope</span></div>
<div class="box">${boxHtml}</div>
${actions}
</div>`;
}

function renderDrawerTool(c: ToolCallTrace): string {
  const dur = c.startMs !== undefined && c.endMs !== undefined ? fmtDuration(c.endMs - c.startMs) : c.status === "running" ? "…" : "—";
  const g = c.status === "ok" ? "ok" : c.status === "error" ? "error" : "running";
  const blocked = c.status === "running";
  const arg = escapeHtml(bound(toolArgPreview(c.input), 160).replace(/\n/g, " ")) || (blocked ? "blocked — awaiting answer" : "");
  const hasBody = c.input !== undefined || (c.result !== undefined && c.result !== null);
  const body: string[] = [];
  if (c.input !== undefined) {
    body.push(
      `<div class="lbl">input</div><div class="box">${escapeHtml(bound(typeof c.input === "string" ? c.input : JSON.stringify(c.input, null, 2), 4000))}</div>`,
    );
  }
  if (c.result !== undefined && c.result !== null) {
    body.push(
      `<div class="lbl">result</div><div class="box">${escapeHtml(bound(typeof c.result === "string" ? c.result : JSON.stringify(c.result, null, 2), 4000))}</div>`,
    );
  }
  const chev = hasBody ? `<span class="chev">▶</span>` : "";
  const toggle = hasBody ? ` onclick="this.parentElement.classList.toggle('open')"` : "";
  return `<div class="dw-tool${blocked ? " blocked" : ""}" data-key="tool-${escapeHtml(c.id)}">
<div class="dw-tool-head"${toggle}>
<span class="g ${g}"></span>
<span class="tn">${escapeHtml(c.name)}</span>
<span class="ta">${arg}</span>
<span class="td">${dur}</span>
${chev}
</div>
${hasBody ? `<div class="dw-tool-body">${body.join("")}</div>` : ""}
</div>`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ---------------------------------------------------------------------------
// Full pages
// ---------------------------------------------------------------------------
export function renderReportHtml(opts: {
  manifest: RunManifest;
  status: RunStatus;
  traces: TraceRecord[];
  live: boolean;
  selectedSeq?: number;
}): string {
  const body = renderRunBody({ ...opts, interactive: false, selectedSeq: opts.selectedSeq });
  return page(`orc ${opts.status.runId}`, body, { refresh: opts.live });
}

const LIVE_SCRIPT = `
var base = location.pathname.replace(/\\/+$/, "");
var app = document.getElementById("app");
var selectedSeq = null;

function fragUrl(){ return base + "/fragment" + (selectedSeq !== null ? "?leaf=" + selectedSeq : ""); }
function openKeys(){
  var s={};
  app.querySelectorAll("[data-key].open,details[data-key][open]").forEach(function(d){ s[d.getAttribute("data-key")]=1; });
  return s;
}
var PANES = [".lanes",".feed-scroll",".dw-scroll"];
function refresh(){
  fetch(fragUrl()).then(function(r){ if(!r.ok) return; return r.text().then(function(html){
    var open = openKeys();
    var scrolls = {};
    PANES.forEach(function(sel){ var el = app.querySelector(sel); if (el) scrolls[sel] = el.scrollTop; });
    app.innerHTML = html;
    Object.keys(open).forEach(function(k){
      var el = app.querySelector('[data-key="'+k+'"]');
      if (!el) return;
      if (el.tagName === "DETAILS") el.setAttribute("open",""); else el.classList.add("open");
    });
    PANES.forEach(function(sel){ var el = app.querySelector(sel); if (el && scrolls[sel] !== undefined) el.scrollTop = scrolls[sel]; });
    layoutBars();
  }); }).catch(function(){});
}
// row click -> open drawer for that leaf
app.addEventListener("click", function(e){
  var strip = e.target.closest && e.target.closest(".appr-actions, .abtn, .dw-allow, .dw-deny, .cancel, .dw-close, .dw-tool");
  if (strip) return; // buttons/tools handle themselves
  var row = e.target.closest && e.target.closest(".row[data-seq]");
  if (!row) return;
  selectedSeq = parseInt(row.getAttribute("data-seq"), 10);
  refresh();
});
window.orcCloseDrawer = function(){ selectedSeq = null; refresh(); };
document.addEventListener("keydown", function(e){ if(e.key === "Escape" && selectedSeq !== null){ selectedSeq = null; refresh(); } });

function fmtDur(ms){ if(ms<1000)return Math.round(ms)+"ms"; var s=ms/1000; if(s<60)return s.toFixed(1)+"s"; var m=Math.floor(s/60); return m+"m "+Math.round(s%60)+"s"; }
function layoutBars(){
  var wf = app.querySelector(".waterfall"); if(!wf) return false;
  var rangeStart = +wf.getAttribute("data-range-start");
  var running = wf.getAttribute("data-running")==="1";
  var now = Date.now(), maxEnd = rangeStart+1;
  wf.querySelectorAll("[data-s]").forEach(function(b){ var e=b.getAttribute("data-e"); var end=e===""?now:+e; if(end>maxEnd)maxEnd=end; });
  var rangeEnd = running ? Math.max(maxEnd, now) : maxEnd;
  var span = Math.max(rangeEnd-rangeStart, 1);
  var pct = function(ms){ return Math.min(Math.max((ms-rangeStart)/span*100,0),100); };
  wf.querySelectorAll("[data-s]").forEach(function(b){
    var s=+b.getAttribute("data-s"); var e=b.getAttribute("data-e"); var end=e===""?now:+e;
    b.style.left = pct(s).toFixed(3)+"%"; b.style.width = Math.max(pct(end)-pct(s),0.5).toFixed(3)+"%";
  });
  wf.querySelectorAll("[data-diamond]").forEach(function(d){ d.style.left = pct(+d.getAttribute("data-diamond")).toFixed(3)+"%"; });
  wf.querySelectorAll(".dur-v").forEach(function(d){ if(d.getAttribute("data-e")==="") d.textContent = fmtDur(now-(+d.getAttribute("data-s"))); });
  return running;
}
function tick(){ if(layoutBars()) requestAnimationFrame(tick); }
var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;

window.orcApprove = function(id, behavior){
  var el = app.querySelector('[data-approval="'+id+'"] .appr-actions') || app.querySelector('[data-approval="'+id+'"] .actions');
  if (el) el.innerHTML = '<span class="resolving">'+(behavior==="allow"?"allowing":"denying")+'…</span>';
  fetch(base + "/approvals/" + encodeURIComponent(id), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({behavior:behavior})}).then(function(){ setTimeout(refresh,1500); });
};
window.orcCancel = function(){ fetch(base + "/cancel", {method:"POST"}).then(function(){ setTimeout(refresh,500); }); };

var es = new EventSource(base + "/events");
es.onmessage = function(){ refresh(); if(!reduce) requestAnimationFrame(tick); };
es.onerror = function(){ es.close(); refresh(); };
if(!reduce) requestAnimationFrame(tick);
`.trim();

export function renderLivePage(opts: { manifest: RunManifest; status: RunStatus; traces: TraceRecord[]; selectedSeq?: number }): string {
  const body = `<div id="app">
${renderRunBody({ ...opts, interactive: true, selectedSeq: opts.selectedSeq })}
</div>`;
  return page(`orc ${opts.status.runId}`, body, { script: LIVE_SCRIPT });
}

export function renderIndexPage(runs: RunManifest[]): string {
  const content = runs.length
    ? `<table><thead><tr><th>run</th><th>name</th><th>harness</th><th>host</th><th>created</th></tr></thead><tbody>
${runs
  .map(
    (m) => `<tr><td><a class="mono" href="/runs/${encodeURIComponent(m.runId)}">${escapeHtml(m.runId)}</a></td><td>${m.name ? escapeHtml(m.name) : ""}</td><td>${escapeHtml(m.defaultHarness)}</td><td>${m.host ? escapeHtml(m.host) : "local"}</td><td class="feed-line">${new Date(m.createdAtMs).toISOString().slice(0, 19).replace("T", " ")}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`
    : `<p class="feed-line">No runs yet.</p>`;
  return page("orc runs", `<main><h1>orc runs</h1>${content}</main>`);
}
