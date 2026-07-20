/**
 * orc monitor renderer — responsive "terminal ops" design.
 *
 * Self-contained output: inline CSS, no external requests, all-monospace.
 * One markup tree serves every width:
 *   - glance header: identity row, stat tiles, a segmented run bar, and the
 *     latest feed event as a single line (the old feed pane is gone);
 *   - collapsible phase cards; timeline tracks appear from 900px up;
 *   - gates render as a bottom dock on small screens and as an inline strip
 *     under the gated row from 900px up;
 *   - the leaf detail is a full-screen page on small screens and a 420px
 *     side drawer from 900px up.
 *
 * Dark is the designed theme; a light mapping is derived via tokens so
 * prefers-color-scheme still works. Font falls back to system mono to keep the
 * static report fully self-contained/offline.
 */
import type {
  ApprovalRequest,
  JournalRecord,
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
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:12px/1.5 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit}
.mono{font-family:inherit}
.tnum{font-variant-numeric:tabular-nums}
.grow{flex:1}

.mon{height:100vh;height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);overflow:hidden}
.logo{width:12px;height:12px;background:var(--amber);border-radius:3px;flex:none}
.run-id{font-size:13px;font-weight:700;color:var(--bright)}
.prog{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{font-size:9.5px;font-weight:700;letter-spacing:.08em;padding:1px 7px;border-radius:3px;border:1px solid;text-transform:uppercase;flex:none}
.chip.running{color:var(--amber);border-color:var(--amber-b)}
.chip.completed,.chip.ok{color:var(--green);border-color:var(--green-b)}
.chip.failed,.chip.error{color:var(--red);border-color:var(--red-b)}
.chip.cancelled,.chip.pending{color:var(--muted);border-color:var(--pill)}
.gate-count{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--bg);background:var(--amber);padding:2px 8px;border-radius:3px;flex:none}
.cancel{font-size:10px;color:var(--muted);border:1px solid var(--border);padding:2px 9px;border-radius:3px;cursor:pointer;background:none;flex:none}
.cancel:hover{color:var(--red);border-color:var(--red-b)}
.seq{color:var(--muted)}
.lbl-id{color:var(--text)}
.cell-dur{font-size:10.5px;color:var(--muted);text-align:right;flex:none}
.cell-dur.run{color:var(--amber)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.dot.ok{background:var(--green)}
.dot.running{background:var(--amber)}
.dot.error{background:var(--red)}
.dot.pending{background:none;border:1px solid var(--pill)}
.eff{border-radius:2px;padding:0 4px;font-size:8.5px;font-weight:700;border:1px solid;text-transform:uppercase;flex:none}
.eff.low{color:var(--muted);border-color:var(--pill)}
.eff.med{color:var(--blue);border-color:var(--blue-b)}
.eff.high{color:var(--amber);border-color:var(--amber-b);background:var(--amber-bg)}
.trk{position:relative;height:8px;flex:none}
.trk .base{position:absolute;inset:3px 0;background:var(--track);border-radius:1px}
.bar{position:absolute;top:0;bottom:0;border-radius:1px}
.bar.ok{background:var(--green)}
.bar.running{background:var(--amber)}
.bar.error{background:var(--red)}
.bar.amber{background:var(--amber)}
.hatch{position:absolute;top:0;bottom:0;border-radius:1px;background:repeating-linear-gradient(45deg,var(--amber-hatch) 0 4px,transparent 4px 8px)}
.diamond{position:absolute;top:-1px;width:10px;height:10px;background:var(--amber);transform:rotate(45deg);box-shadow:0 0 10px var(--amber-b);border:1px solid var(--bg)}
@media (prefers-reduced-motion:no-preference){.bar,.hatch{transition:left .25s ease,width .25s ease}}
.bar.running,.hatch,.diamond{transition:none}
.gate-tag{font-size:8.5px;font-weight:700;letter-spacing:.1em;color:var(--bg);background:var(--amber);padding:1px 6px;border-radius:2px;flex:none}
.box{font-size:10.5px;color:var(--secondary);background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:7px 10px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.box.capped{max-height:180px;overflow-y:auto}
.fts{font-size:9.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.add{color:var(--green)}
.del{color:var(--red)}
.appr-actions{display:flex;gap:8px;align-items:center}
.resolving{font-size:10.5px;color:var(--muted);flex:none}

.glance{padding:12px 14px 10px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:10px;flex:none}
.g-h1{display:flex;align-items:center;gap:8px;min-width:0}
.g-nums{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.g-num{display:flex;flex-direction:column;gap:1px}
.g-nv{font-size:15px;font-weight:700;color:var(--bright);line-height:1.2}
.g-nv.gated{color:var(--amber)}
.g-nk{font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.g-prog{display:flex;gap:2px;height:6px;flex:none;min-width:120px}
.g-seg{flex:1;border-radius:1px;background:var(--track)}
.g-seg.ok{background:var(--green)}
.g-seg.running,.g-seg.gated{background:var(--amber)}
.g-seg.error{background:var(--red)}
.g-last{font-size:10px;color:var(--muted);display:flex;gap:8px;align-items:baseline;min-width:0}
.g-lastmsg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.g-lastmsg b{color:var(--text);font-weight:700}
.g-meta{display:none;gap:16px;font-size:10px;color:var(--muted)}
.g-meta b{color:var(--text);font-weight:400}
.g-meta .okw{color:var(--green)}

.mbody{flex:1;display:flex;align-items:stretch;min-height:0}
.main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.scroll{flex:1;overflow-y:auto;padding:10px 14px;min-height:0}
.c-phase{border:1px solid var(--hair);border-radius:5px;margin-bottom:8px;overflow:hidden}
.c-ph{display:flex;align-items:center;gap:9px;padding:0 11px;min-height:44px;cursor:pointer;background:var(--rowhover)}
.c-pn{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--bright);flex:none}
.c-pc{font-size:10px;color:var(--muted);flex:none}
.c-ph .trk{flex:1;height:6px;min-width:0}
.c-ph .trk .base{inset:2px 0}
.c-ph .bar{opacity:.85}
.chev{color:var(--faint);font-size:8px;flex:none;transition:transform .15s}
.c-phase:not(.closed)>.c-ph .chev{transform:rotate(90deg)}
.c-phase.closed>.c-rows{display:none}
.c-rows{padding:0 11px}
.c-row{display:flex;align-items:center;gap:9px;min-height:46px;border-top:1px solid var(--hair);cursor:pointer}
.c-row:hover{background:var(--rowhover)}
.c-row.gated{background:var(--amber-tint)}
.c-row.gated:hover{background:var(--amber-tint2)}
.c-row.queued{opacity:.55;cursor:default}
.c-row.sel{outline:1px solid var(--amber);outline-offset:-1px}
.c-row.sel .seq{color:var(--amber)}
.c-row.sel .lbl-id{color:var(--bright)}
.rl{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.rl1{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px}
.rl2{font-size:9.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trk.r-trk{display:none;flex:1;min-width:0}

.dock{flex:none;border-top:2px solid var(--amber);background:var(--amber-strip);padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px}
.strip-inline{display:none;align-items:center;gap:12px;padding:7px 10px;margin:0 0 2px;background:var(--amber-strip);border-left:2px solid var(--amber)}
.sbtn{font-size:10.5px;font-weight:700;letter-spacing:.06em;padding:3px 12px;border-radius:3px;cursor:pointer;border:1px solid;background:none;flex:none}
.sbtn.allow{color:var(--green);border-color:var(--green-b)}
.sbtn.allow:hover{background:var(--green-bg)}
.sbtn.deny{color:var(--red);border-color:var(--red-b)}
.sbtn.deny:hover{background:var(--red-bg)}
.dk-line{display:flex;gap:8px;align-items:center;min-width:0}
.dk-tool{font-size:11px;color:var(--bright);font-weight:500;flex:none}
.dk-arg{font-size:11px;color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dk-wait{font-size:9.5px;color:var(--muted)}
.dk-btns{display:flex;gap:8px}
.abtn{font-size:11px;font-weight:700;letter-spacing:.06em;min-height:42px;border-radius:4px;cursor:pointer;border:1px solid;background:none;flex:1;max-width:220px}
.abtn.allow{color:var(--green);border-color:var(--green-b)}
.abtn.allow:hover{background:var(--green-bg)}
.abtn.deny{color:var(--red);border-color:var(--red-b)}
.abtn.deny:hover{background:var(--red-bg)}

.detail{position:fixed;inset:0;background:var(--bg);z-index:20;display:flex;flex-direction:column}
.d-back{display:flex;align-items:center;gap:10px;padding:0 14px;min-height:48px;border-bottom:1px solid var(--border);cursor:pointer;flex:none}
.d-back:hover{background:var(--rowhover)}
.d-arrow{font-size:18px;color:var(--muted);line-height:1}
.d-backlbl{font-size:11px;color:var(--muted)}
.d-close{display:inline;font-size:14px;color:var(--muted);cursor:pointer;background:none;border:none;padding:8px;margin:-8px}
.d-close:hover{color:var(--text)}
.d-title{font-size:13px;font-weight:700;color:var(--bright)}
.d-title .seq{color:var(--amber)}
.dw-scroll{flex:1;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:12px}
.dw-meta{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:10.5px}
.dw-meta .k{color:var(--faint)}
.dw-meta .v{color:var(--secondary)}
.dw-gate{border:1px solid var(--amber-b);border-left:2px solid var(--amber);background:var(--amber-tint);padding:10px 12px;display:flex;flex-direction:column;gap:9px}
.dw-gtitle{display:flex;align-items:center;gap:8px}
.wants{font-size:10.5px;color:var(--secondary)}
.wants b{color:var(--bright);font-weight:700}
.actions{display:flex;gap:8px}
.dw-allow{flex:1;text-align:center;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--bg);background:var(--green);min-height:42px;border-radius:4px;cursor:pointer;border:none}
.dw-allow:hover{filter:brightness(1.1)}
.dw-deny{flex:1;text-align:center;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--red);border:1px solid var(--red-b);min-height:42px;border-radius:4px;cursor:pointer;background:none}
.dw-deny:hover{background:var(--red-bg)}
.static-note{font-size:10.5px;color:var(--muted);margin-top:2px}
.dw-sec{display:flex;flex-direction:column;gap:5px}
.dw-sec-hdr{font-size:9.5px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
.dw-tools{display:flex;flex-direction:column}
.dw-tool{display:flex;flex-direction:column;padding:6px 0;border-bottom:1px solid var(--hair)}
.dw-tool:last-child{border-bottom:none}
.dw-tool-head{display:flex;align-items:center;gap:8px}
.dw-tool-head .g{width:6px;height:6px;border-radius:50%;flex:none}
.dw-tool-head .g.ok{background:var(--green)}
.dw-tool-head .g.error{background:var(--red)}
.dw-tool-head .g.running{background:var(--amber);border-radius:0;transform:rotate(45deg)}
.dw-tool-head .tn{font-size:10.5px;color:var(--text);flex:none}
.dw-tool.blocked .dw-tool-head .tn{color:var(--amber)}
.dw-tool-head .ta{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dw-tool-head .td{font-size:9.5px;color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.dw-tool.blocked .dw-tool-head .td{color:var(--amber)}
.dw-tool-head .chev{font-size:9px}
.dw-tool-head[onclick]{cursor:pointer}
.dw-tool.open .dw-tool-head .chev{transform:rotate(90deg)}
.dw-tool-body{display:none;flex-direction:column;gap:6px;padding:7px 0 2px}
.dw-tool.open .dw-tool-body{display:flex}
.dw-tool-body .lbl{font-size:9.5px;letter-spacing:.1em;color:var(--faint);text-transform:uppercase}
.dw-tool-body .box{max-height:220px;overflow:auto}
.dw-usage{display:flex;gap:14px;font-size:10.5px;color:var(--muted);border-top:1px solid var(--border);padding-top:9px}
.dw-usage .sess{color:var(--faint);margin-left:auto}
details.hlog>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;font-size:9.5px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
details.hlog>summary::-webkit-details-marker{display:none}
details.hlog>summary::before{content:"▸";color:var(--faint);font-size:9px}
details.hlog[open]>summary::before{content:"▾"}
details.hlog .box{margin-top:6px;max-height:220px;overflow-y:auto}
details.hlog .dw-tools{margin-top:4px}
.hl-line{display:flex;gap:8px;align-items:baseline}
.hl-line .cnt{color:var(--red);font-weight:700;flex:none}
.badge-n{font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--muted);background:var(--track);padding:0 6px;border-radius:7px}
.empty{font-size:11px;color:var(--muted);padding:8px 2px}

@media (min-width:900px){
.glance{flex-direction:row;align-items:center;gap:22px;padding:14px 22px;flex-wrap:wrap}
.g-h1{flex:none;gap:10px;min-width:0;max-width:40%}
.run-id{font-size:15px}
.prog{font-size:12px}
.g-nums{display:flex;gap:26px;flex:none}
.g-nv{font-size:16px}
.g-last{flex:1;justify-content:flex-end;min-width:160px}
.scroll{padding:12px 22px}
.c-rows{padding:0 14px}
.c-row{gap:12px;min-height:44px}
.rl{flex:none;width:300px;flex-direction:row;align-items:baseline;gap:10px}
.rl1{flex:none;width:150px}
.rl2{flex:1}
.trk.r-trk{display:block}
.cell-dur{width:64px}
.c-ph{padding:0 14px}
.c-ph .trk{max-width:280px}
.dock{display:none}
.strip-inline{display:flex}
.detail{position:static;inset:auto;width:420px;flex:none;border-left:1px solid var(--border);background:var(--drawer);box-shadow:-12px 0 28px rgba(0,0,0,.35);z-index:1}
.d-back{cursor:default}
.d-back:hover{background:none}
}
@media (min-width:1200px){
.g-meta{display:flex;flex:none}
}

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
  /** Durable cost records; traces remain the fallback for legacy runs. */
  journal?: JournalRecord[];
  /** true = live server page (working gate buttons, detail, SSE). */
  interactive: boolean;
  /** seq of the leaf whose detail view is open (undefined = closed). */
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
function rollupCost(traces: TraceRecord[], journal: JournalRecord[] = []): CostRollup {
  const attempts = new Map<string, { costUsd: number; costEstimated: boolean; rev?: number }>();
  for (const trace of traces) {
    if (trace.t !== "leaf" || trace.costUsd === undefined) continue;
    const key = `${trace.seq}:${trace.attempt}`;
    const current = attempts.get(key);
    if (!current || trace.rev >= (current.rev ?? -1)) {
      attempts.set(key, {
        costUsd: trace.costUsd,
        costEstimated: trace.costEstimated ?? false,
        rev: trace.rev,
      });
    }
  }
  for (const record of journal) {
    if (record.t === "cost") {
      attempts.set(`${record.seq}:${record.attempt}`, {
        costUsd: record.costUsd,
        costEstimated: record.costEstimated,
      });
    }
  }
  let total = 0;
  let anyEstimated = false;
  let anyExact = false;
  let present = false;
  for (const tr of attempts.values()) {
    present = true;
    total += tr.costUsd;
    if (tr.costEstimated) anyEstimated = true;
    else anyExact = true;
  }
  return { total, anyEstimated, anyExact, present };
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
  const cost = rollupCost(traces, view.journal);

  const detailPage =
    view.selectedSeq !== undefined && status.leaves.some((l) => l.seq === view.selectedSeq)
      ? renderDetail(view, detail, gatesBySeq, nowMs)
      : "";
  const dock = renderDock(status, approvals, view.interactive, nowMs);

  return `<div class="mon">
${renderGlance(manifest, status, gatesBySeq, cost, events, view.interactive, nowMs)}
<div class="mbody">
<div class="main">
<div class="scroll">
${renderPhases(status, detail, gatesBySeq, view, nowMs)}
</div>
${dock}
</div>
${detailPage}
</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Glance header
// ---------------------------------------------------------------------------
/** The "~" prefix marks a total that includes estimated (rate-table) spend. */
function costTile(cost: CostRollup, budgetUsd: number | undefined): { value: string; label: string } {
  const value = `${cost.anyEstimated ? "~" : ""}$${cost.present ? cost.total.toFixed(2) : "0.00"}`;
  const budget = budgetUsd !== undefined ? ` / $${budgetUsd.toFixed(2)}` : "";
  return { value, label: `cost${budget}` };
}

/** The latest feed event as one line: timestamp + short message. */
function latestEventLine(events: RunEventRecord[]): { atMs: number; msg: string } | undefined {
  const e = events[events.length - 1];
  if (!e) return undefined;
  let msg: string;
  switch (e.event.kind) {
    case "phase":
      msg = `→ <b>${escapeHtml(e.event.name)}</b>`;
      break;
    case "approval-requested":
      msg = `GATE <b>${escapeHtml(e.event.approval.toolName)}</b> · agent#${e.event.approval.seq}`;
      break;
    case "approval-resolved":
      msg = `${e.event.decision.behavior === "allow" ? "allowed" : "denied"} by ${escapeHtml(e.event.by)}`;
      break;
    case "denied":
      msg = `<b>${escapeHtml(e.event.toolName)}</b> denied · agent#${e.event.seq}`;
      break;
    case "log":
    default:
      msg = escapeHtml(e.event.kind === "log" ? e.event.message : "");
  }
  return { atMs: e.atMs, msg };
}

function segClass(leaf: LeafStatus, gated: boolean): string {
  if (gated) return "gated";
  if (leaf.status === "pending") return "";
  return leaf.status;
}

function renderGlance(
  manifest: RunManifest,
  status: RunStatus,
  gatesBySeq: Map<number, ApprovalRequest[]>,
  cost: CostRollup,
  events: RunEventRecord[],
  interactive: boolean,
  nowMs: number,
): string {
  const name = manifest.name ?? manifest.programPath.split("/").pop() ?? "program";
  const running = status.state === "running";
  const endMs = status.endedAtMs ?? nowMs;
  const gateCount = [...gatesBySeq.values()].reduce((n, arr) => n + arr.length, 0);
  const gates =
    gateCount > 0 ? `<span class="gate-count">${gateCount} GATE${gateCount === 1 ? "" : "S"}</span>` : "";
  const cancel = interactive && running ? `<button class="cancel" onclick="orcCancel()">CANCEL</button>` : "";
  const done = status.ok + status.failed;
  const c = costTile(cost, manifest.budgetUsd);
  const segs = status.leaves
    .map((l) => {
      const gated = l.status === "running" && (gatesBySeq.get(l.seq)?.length ?? 0) > 0;
      const cls = segClass(l, gated);
      return `<span class="g-seg${cls ? " " + cls : ""}"></span>`;
    })
    .join("");
  const latest = latestEventLine(events);
  const last = latest
    ? `<div class="g-last"><span class="fts tnum">${fmtClock(latest.atMs)}</span><span class="g-lastmsg">${latest.msg}</span></div>`
    : "";
  return `<div class="glance">
<div class="g-h1">
<span class="logo"></span>
<span class="run-id">${escapeHtml(status.runId)}</span>
<span class="prog">${escapeHtml(name)}</span>
<span class="chip ${status.state}">${status.state}</span>
<span class="grow"></span>
${[gates, cancel].filter(Boolean).join("")}
</div>
<div class="g-nums">
<div class="g-num"><span class="g-nv tnum">${done}/${status.totalCalls}</span><span class="g-nk">leaves</span></div>
<div class="g-num"><span class="g-nv tnum" data-elapsed-start="${status.startedAtMs}" data-elapsed-end="${running ? "" : endMs}">${fmtElapsed(endMs - status.startedAtMs)}</span><span class="g-nk">elapsed</span></div>
<div class="g-num"><span class="g-nv tnum">${c.value}</span><span class="g-nk">${escapeHtml(c.label)}</span></div>
<div class="g-num"><span class="g-nv tnum${gateCount > 0 ? " gated" : ""}">${gateCount}</span><span class="g-nk">gates</span></div>
</div>
<div class="g-prog">${segs}</div>
<div class="g-meta"><span>approval <b>${escapeHtml(status.approvalMode)}</b></span><span>writes ${status.allowWrites ? '<b class="okw">granted</b>' : "<b>read-only</b>"}</span><span>started <b>${fmtStampClock(status.startedAtMs)}</b></span></div>
${last}
</div>`;
}

// ---------------------------------------------------------------------------
// Phase cards
// ---------------------------------------------------------------------------
function renderPhases(
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
  const groups: { phase: string | undefined; leaves: LeafStatus[] }[] = [];
  for (const leaf of status.leaves) {
    const last = groups[groups.length - 1];
    if (last && last.phase === leaf.phase) last.leaves.push(leaf);
    else groups.push({ phase: leaf.phase, leaves: [leaf] });
  }

  const cards = groups.map((g) => renderPhaseCard(g.phase, g.leaves, detail, gatesBySeq, view, pct, nowMs));
  const content = cards.length ? cards.join("\n") : `<div class="empty">no calls yet</div>`;
  const anyRunning = status.leaves.some((l) => l.status === "running");
  return `<section class="waterfall" data-range-start="${rangeStart}" data-running="${anyRunning ? 1 : 0}">
${content}
</section>`;
}

function renderPhaseCard(
  phase: string | undefined,
  leaves: LeafStatus[],
  detail: Map<number, LeafTraceRecord>,
  gatesBySeq: Map<number, ApprovalRequest[]>,
  view: RunView,
  pct: (ms: number) => number,
  nowMs: number,
): string {
  const rows = leaves
    .map((leaf) => renderLeafRow(leaf, detail.get(leaf.seq), gatesBySeq.get(leaf.seq), view, pct, nowMs))
    .join("\n");
  if (!phase) {
    return `<div class="c-phase"><div class="c-rows">
${rows}
</div></div>`;
  }
  const done = leaves.filter((l) => l.status === "ok" || l.status === "error").length;
  const mini = leaves
    .map((leaf) => {
      if (leaf.startMs === undefined) return "";
      const gated = (gatesBySeq.get(leaf.seq)?.length ?? 0) > 0 && leaf.status === "running";
      const running = leaf.status === "running";
      const end = running ? nowMs : (leaf.endMs ?? leaf.startMs);
      const cls = gated ? "amber" : running ? "running" : leaf.status === "ok" ? "ok" : "error";
      const s = pct(leaf.startMs);
      const w = Math.max(pct(end) - s, 0.5);
      return `<span class="bar ${cls}" data-s="${leaf.startMs}" data-e="${running ? "" : end}" style="left:${s.toFixed(2)}%;width:${w.toFixed(2)}%"></span>`;
    })
    .join("");
  return `<div class="c-phase" data-key="phase-${escapeHtml(phase)}">
<div class="c-ph" data-toggle="1"><span class="c-pn">${escapeHtml(phase)}</span><span class="c-pc tnum">${done}/${leaves.length}</span><span class="trk"><span class="base"></span>${mini}</span><span class="chev">▶</span></div>
<div class="c-rows">
${rows}
</div>
</div>`;
}

function renderLeafRow(
  leaf: LeafStatus,
  tr: LeafTraceRecord | undefined,
  gates: ApprovalRequest[] | undefined,
  view: RunView,
  pct: (ms: number) => number,
  nowMs: number,
): string {
  const gated = !!gates && gates.length > 0 && leaf.status === "running";
  const queued = leaf.status === "pending" && leaf.startMs === undefined;
  const sel = view.selectedSeq === leaf.seq;
  const cls = ["c-row", gated ? "gated" : "", queued ? "queued" : "", sel ? "sel" : ""].filter(Boolean).join(" ");

  const idLabel = leaf.id ? ` <span class="lbl-id">${escapeHtml(leaf.id)}</span>` : "";
  const gateTag = gated ? `<span class="gate-tag">GATE</span>` : "";
  const eff = tr?.reasoningEffort ? effortPill(tr.reasoningEffort) : "";

  const harness = leaf.harness ?? tr?.harness;
  const model = tr?.model ? tr.model.replace(/^claude-/, "") : undefined;
  const host = leaf.host ?? tr?.host;
  const rt2 = queued
    ? "queued"
    : [harness, model].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ") +
      (host ? ` <span class="seq">@${escapeHtml(host)}</span>` : "");

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
<span class="dot ${dotCls}"></span>
<span class="rl">
<span class="rl1"><span class="seq">${leaf.kind}#${leaf.seq}</span>${idLabel}${gateTag}${eff}</span>
<span class="rl2">${rt2}</span>
</span>
<span class="trk r-trk">${track}</span>
<span class="${durCls} tnum">${dur}</span>
</div>`;

  const strips = gated ? gates!.map((g) => renderGateStrip(g, view.interactive, nowMs)).join("\n") : "";
  return row + (strips ? "\n" + strips : "");
}

// ---------------------------------------------------------------------------
// Gates: inline strip (≥900px) + bottom dock (<900px)
// ---------------------------------------------------------------------------
function approveButtons(a: ApprovalRequest, interactive: boolean, btnCls: string): string {
  const buttons = interactive
    ? `<button class="${btnCls} allow" onclick="orcApprove('${escapeHtml(a.id)}','allow')">ALLOW</button><button class="${btnCls} deny" onclick="orcApprove('${escapeHtml(a.id)}','deny')">DENY</button>`
    : `<span class="resolving">respond with orc approvals</span>`;
  return buttons;
}

function renderGateStrip(a: ApprovalRequest, interactive: boolean, nowMs: number): string {
  const arg = escapeHtml(bound(toolArgPreview(a.input), 200).replace(/\n/g, " "));
  return `<div class="strip-inline" data-approval="${escapeHtml(a.id)}">
<span class="gate-tag">GATE</span>
<span class="dk-tool">${escapeHtml(a.toolName)}</span>
<span class="dk-arg">${arg}</span>
<span class="dk-wait">waiting <span class="wait-v" data-since="${a.requestedAtMs}">${fmtDuration(nowMs - a.requestedAtMs)}</span></span>
<span class="appr-actions">${approveButtons(a, interactive, "sbtn")}</span>
</div>`;
}

/** Small screens: the first open gate as a fixed dock above the fold. */
function renderDock(status: RunStatus, approvals: ApprovalRequest[], interactive: boolean, nowMs: number): string {
  const a = approvals[0];
  if (!a) return "";
  const leaf = status.leaves.find((l) => l.seq === a.seq);
  const arg = escapeHtml(bound(toolArgPreview(a.input), 200).replace(/\n/g, " "));
  const where = leaf
    ? ` · ${leaf.readOnly ? "read-only" : "write"} leaf${leaf.host ? ` on @${escapeHtml(leaf.host)}` : ""}`
    : "";
  return `<div class="dock" data-approval="${escapeHtml(a.id)}">
<div class="dk-line"><span class="gate-tag">GATE</span><span class="dk-tool">${leaf ? `${leaf.kind}#${leaf.seq} · ` : ""}${escapeHtml(a.toolName)}</span><span class="dk-arg">${arg}</span></div>
<div class="dk-line"><span class="dk-wait">waiting <span class="wait-v" data-since="${a.requestedAtMs}">${fmtDuration(nowMs - a.requestedAtMs)}</span>${where}</span></div>
<div class="dk-btns appr-actions">${approveButtons(a, interactive, "abtn")}</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Leaf detail — full-screen page (<900px) / side drawer (≥900px)
// ---------------------------------------------------------------------------
function renderDetail(
  view: RunView,
  detail: Map<number, LeafTraceRecord>,
  gatesBySeq: Map<number, ApprovalRequest[]>,
  nowMs: number,
): string {
  const leaf = view.status.leaves.find((l) => l.seq === view.selectedSeq)!;
  const gates = gatesBySeq.get(leaf.seq) ?? [];
  const gated = gates.length > 0 && leaf.status === "running";
  const statusTag = gated ? "gated" : leaf.status;
  const statusClass = gated ? "running" : leaf.status;
  const back = view.interactive ? ` onclick="orcCloseDrawer()"` : "";
  const close = view.interactive ? `<button class="d-close" onclick="orcCloseDrawer()">✕</button>` : "";
  return `<div class="detail">
<div class="d-back"${back}><span class="d-arrow">‹</span><span class="d-backlbl">${escapeHtml(view.status.runId)}</span><span class="grow"></span><span class="chip ${statusClass}">${escapeHtml(statusTag)}</span>${close}</div>
<div class="dw-scroll">
<div class="d-title"><span class="seq">${leaf.kind}#${leaf.seq}</span>${leaf.id ? " " + escapeHtml(leaf.id) : ""}</div>
${renderLaneContent(view, leaf, detail, gates, nowMs)}
</div>
</div>`;
}

/** The inner sections shared by the live detail view and the report snapshot. */
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
  } else {
    meta.push(`<span class="k">started</span><span class="v">queued</span>`);
  }
  const host = leaf.host ?? tr?.host;
  meta.push(`<span class="k">cwd</span><span class="v">${escapeHtml(tr?.cwd ?? view.manifest.cwd)} · ${host ? "@" + escapeHtml(host) : "local"}</span>`);
  const idle = view.manifest.idleTimeoutMs === false ? "disabled" : `${Math.round((view.manifest.idleTimeoutMs as number) / 60000)}m`;
  meta.push(`<span class="k">idle timeout</span><span class="v">${idle}</span>`);

  const gateBlock = gated ? renderDetailGate(gates[0], view.interactive) : "";

  const promptSec = tr?.prompt
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Prompt</div><div class="box capped">${escapeHtml(bound(tr.prompt, 6000))}</div></div>`
    : "";

  // A string output renders raw (not as an escaped JSON literal); either way
  // the box is capped and scrolls itself so a long answer can't stretch the view.
  const outputSec =
    tr?.output !== undefined
      ? `<div class="dw-sec"><div class="dw-sec-hdr">Output</div><div class="box capped">${escapeHtml(bound(typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output, null, 2), 16384))}</div></div>`
      : "";
  const errSec = leaf.error ?? tr?.error
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Error</div><div class="box capped" style="color:var(--red)">${escapeHtml(bound((leaf.error ?? tr?.error)!, 4096))}</div></div>`
    : "";

  // Newest tool calls first; only the latest 4 visible, the rest behind a
  // collapsed expander so a chatty leaf doesn't swamp the view.
  const tools = [...(tr?.toolCalls ?? [])].reverse();
  const visibleTools = tools.slice(0, 4);
  const olderTools = tools.slice(4);
  const toolsSec = tools.length
    ? `<div class="dw-sec"><div class="dw-sec-hdr">Tool calls · ${tools.length}</div><div class="dw-tools">${visibleTools.map((c) => renderDetailTool(c)).join("")}</div>${
        olderTools.length
          ? `<details class="hlog" data-key="tools-more-${leaf.seq}"><summary>${olderTools.length} earlier call${olderTools.length === 1 ? "" : "s"}</summary><div class="dw-tools">${olderTools.map((c) => renderDetailTool(c)).join("")}</div></details>`
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
  return `<details class="hlog" data-key="hlog-${seq}"><summary>Harness log<span class="badge-n">${lines.length} line${lines.length === 1 ? "" : "s"}${dupes > 0 ? ` · ${dupes} dup` : ""}</span></summary><div class="box">${body}${more}</div></details>`;
}

function renderDetailGate(a: ApprovalRequest, interactive: boolean): string {
  const raw = typeof a.input === "string" ? a.input : toolArgPreview(a.input) || JSON.stringify(a.input, null, 2);
  // color diff-like lines
  const boxHtml = escapeHtml(bound(raw, 4000))
    .split("\n")
    .map((l) => (l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") || l.startsWith("−") ? `<span class="del">${l}</span>` : l))
    .join("\n");
  const actions = interactive
    ? `<div class="actions appr-actions"><button class="dw-allow" onclick="orcApprove('${escapeHtml(a.id)}','allow')">ALLOW</button><button class="dw-deny" onclick="orcApprove('${escapeHtml(a.id)}','deny')">DENY</button></div>`
    : `<div class="static-note">respond with <b>orc approvals</b></div>`;
  return `<div class="dw-gate" data-approval="${escapeHtml(a.id)}">
<div class="dw-gtitle"><span class="gate-tag">GATE</span><span class="wants">wants <b>${escapeHtml(a.toolName)}</b> · outside auto-approved scope</span></div>
<div class="box">${boxHtml}</div>
${actions}
</div>`;
}

function renderDetailTool(c: ToolCallTrace): string {
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
  journal?: JournalRecord[];
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
function keyState(){
  var open={}, closed={};
  app.querySelectorAll("[data-key]").forEach(function(d){
    var k = d.getAttribute("data-key");
    if (d.tagName === "DETAILS") { if (d.open) open[k]=1; }
    else if (d.classList.contains("open")) open[k]=1;
    else if (d.classList.contains("closed")) closed[k]=1;
  });
  return { open: open, closed: closed };
}
var PANES = [".scroll",".dw-scroll"];
function refresh(){
  fetch(fragUrl()).then(function(r){ if(!r.ok) return; return r.text().then(function(html){
    var ks = keyState();
    var scrolls = {};
    PANES.forEach(function(sel){ var el = app.querySelector(sel); if (el) scrolls[sel] = el.scrollTop; });
    app.innerHTML = html;
    Object.keys(ks.open).forEach(function(k){
      var el = app.querySelector('[data-key="'+k+'"]');
      if (!el) return;
      if (el.tagName === "DETAILS") el.setAttribute("open",""); else el.classList.add("open");
    });
    Object.keys(ks.closed).forEach(function(k){
      var el = app.querySelector('[data-key="'+k+'"]');
      if (el) el.classList.add("closed");
    });
    PANES.forEach(function(sel){ var el = app.querySelector(sel); if (el && scrolls[sel] !== undefined) el.scrollTop = scrolls[sel]; });
    layoutBars();
  }); }).catch(function(){});
}
// clicks: phase header toggles its card; a row opens the detail; back/✕ closes
app.addEventListener("click", function(e){
  var skip = e.target.closest && e.target.closest(".appr-actions, .abtn, .sbtn, .dw-allow, .dw-deny, .cancel, .d-close, .dw-tool, details, a");
  if (skip) return; // buttons/tools handle themselves
  var ph = e.target.closest && e.target.closest(".c-ph[data-toggle]");
  if (ph) { ph.parentElement.classList.toggle("closed"); return; }
  var back = e.target.closest && e.target.closest(".d-back");
  if (back) { orcCloseDrawer(); return; }
  var row = e.target.closest && e.target.closest(".c-row[data-seq]");
  if (!row) return;
  selectedSeq = parseInt(row.getAttribute("data-seq"), 10);
  refresh();
});
window.orcCloseDrawer = function(){ selectedSeq = null; refresh(); };
document.addEventListener("keydown", function(e){ if(e.key === "Escape" && selectedSeq !== null){ selectedSeq = null; refresh(); } });

function fmtDur(ms){ if(ms<1000)return Math.round(ms)+"ms"; var s=ms/1000; if(s<60)return s.toFixed(1)+"s"; var m=Math.floor(s/60); return m+"m "+Math.round(s%60)+"s"; }
function fmtEl(ms){ if(ms<0)ms=0; var t=Math.floor(ms/1000); var s=t%60, m=Math.floor(t/60)%60, h=Math.floor(t/3600); var p=function(n){return String(n).padStart(2,"0");}; return (h>0?h+":"+p(m):p(m))+":"+p(s); }
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
  app.querySelectorAll(".dur-v").forEach(function(d){ if(d.getAttribute("data-e")==="") d.textContent = fmtDur(now-(+d.getAttribute("data-s"))); });
  app.querySelectorAll(".wait-v").forEach(function(d){ d.textContent = fmtDur(now-(+d.getAttribute("data-since"))); });
  var el = app.querySelector("[data-elapsed-start]");
  if (el && el.getAttribute("data-elapsed-end")==="") el.textContent = fmtEl(now-(+el.getAttribute("data-elapsed-start")));
  return running;
}
function tick(){ if(layoutBars()) requestAnimationFrame(tick); }
var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;

window.orcApprove = function(id, behavior){
  app.querySelectorAll('[data-approval="'+id+'"] .appr-actions').forEach(function(el){
    el.innerHTML = '<span class="resolving">'+(behavior==="allow"?"allowing":"denying")+'…</span>';
  });
  fetch(base + "/approvals/" + encodeURIComponent(id), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({behavior:behavior})}).then(function(){ setTimeout(refresh,1500); });
};
window.orcCancel = function(){ fetch(base + "/cancel", {method:"POST"}).then(function(){ setTimeout(refresh,500); }); };

var es = new EventSource(base + "/events");
es.onmessage = function(){ refresh(); if(!reduce) requestAnimationFrame(tick); };
es.onerror = function(){ es.close(); refresh(); };
if(!reduce) requestAnimationFrame(tick);
`.trim();

export function renderLivePage(opts: { manifest: RunManifest; status: RunStatus; traces: TraceRecord[]; journal?: JournalRecord[]; selectedSeq?: number }): string {
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
    (m) => `<tr><td><a class="mono" href="/runs/${encodeURIComponent(m.runId)}">${escapeHtml(m.runId)}</a></td><td>${m.name ? escapeHtml(m.name) : ""}</td><td>${escapeHtml(m.defaultHarness)}</td><td>${m.host ? escapeHtml(m.host) : "local"}</td><td class="empty">${new Date(m.createdAtMs).toISOString().slice(0, 19).replace("T", " ")}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`
    : `<p class="empty">No runs yet.</p>`;
  return page("orc runs", `<main><h1>orc runs</h1>${content}</main>`);
}
