/**
 * MonitorServer — a plain node:http live monitor for orc runs. No frameworks.
 * Binds 127.0.0.1 only; run/approval path segments validated [a-zA-Z0-9_-]+.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { ControlMessage, LeafTraceRecord, RunEventRecord, TraceRecord } from "@orc/core/src/contracts.js";
import { appendControl, listRuns, orcHome, readManifest, readTraces, runPaths } from "@orc/core/src/rundir.js";
import { statusForRun } from "@orc/core/src/status.js";
import { renderIndexPage, renderLivePage, renderRunBody } from "./render.js";

const ID_RE = /^[a-zA-Z0-9_-]+$/;

/** ?leaf=<seq> selects the drawer lane; returns undefined when absent/invalid. */
function parseSeqParam(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  const v = new URLSearchParams(url.slice(q + 1)).get("leaf");
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
const TRUNC_LIMIT = 16 * 1024;
const SSE_DEBOUNCE_MS = 250;
const SSE_POLL_MS = 1500;
const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Deterministic port
// ---------------------------------------------------------------------------
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 41000 + (fnv1a32(home) % 2000) — stable per state home. */
export function portForHome(home: string): number {
  return 41000 + (fnv1a32(home) % 2000);
}

// ---------------------------------------------------------------------------
// trace.json bounding
// ---------------------------------------------------------------------------
function boundString(s: string): string {
  if (s.length <= TRUNC_LIMIT) return s;
  return s.slice(0, TRUNC_LIMIT) + `… [truncated: ${Buffer.byteLength(s, "utf8")} bytes total]`;
}

function boundTrace(rec: TraceRecord): TraceRecord {
  if (rec.t !== "leaf") return rec;
  const out: LeafTraceRecord = { ...rec };
  if (out.prompt !== undefined) out.prompt = boundString(out.prompt);
  if (out.brief !== undefined) out.brief = boundString(out.brief);
  if (out.error !== undefined) out.error = boundString(out.error);
  if (out.output !== undefined) {
    const serialized = JSON.stringify(out.output);
    if (serialized.length > TRUNC_LIMIT) {
      out.output = `[output truncated: ${Buffer.byteLength(serialized, "utf8")} bytes]`;
    }
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export class MonitorServer {
  private server: http.Server | undefined;
  private boundPort: number | undefined;
  private readonly sseCleanups = new Set<() => void>();

  /** Bind 127.0.0.1 on the deterministic port, falling back to +1..+20. */
  async start(): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error("server already started");
    const base = portForHome(orcHome());
    let lastErr: unknown;
    for (let i = 0; i <= 20; i++) {
      const port = base + i;
      try {
        this.server = await this.listen(port);
        this.boundPort = port;
        return { port, url: this.url };
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      }
    }
    throw new Error(`no free port in ${base}..${base + 20}: ${String(lastErr)}`);
  }

  private listen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        server.on("error", () => {
          /* post-bind socket errors are per-connection concerns */
        });
        resolve(server);
      });
    });
  }

  get url(): string {
    if (this.boundPort === undefined) throw new Error("server not started");
    return `http://127.0.0.1:${this.boundPort}`;
  }

  urlForRun(runId: string): string {
    return `${this.url}/runs/${runId}`;
  }

  async stop(): Promise<void> {
    for (const cleanup of [...this.sseCleanups]) cleanup();
    this.sseCleanups.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map((p) => decodeURIComponent(p));

      if (req.method === "GET" && parts.length === 0) {
        return this.sendHtml(res, renderIndexPage(listRuns()));
      }
      if (parts[0] !== "runs" || parts.length < 2) return this.sendText(res, 404, "not found");

      const runId = parts[1]!;
      if (!ID_RE.test(runId)) return this.sendText(res, 400, "invalid run id");
      if (!fs.existsSync(runPaths(runId).manifest)) return this.sendText(res, 404, "no such run");
      const rest = parts.slice(2);

      if (req.method === "GET") {
        const selectedSeq = parseSeqParam(req.url);
        if (rest.length === 0) return this.sendHtml(res, renderLivePage({ ...this.project(runId), selectedSeq }));
        if (rest.length === 1) {
          switch (rest[0]) {
            case "fragment":
              return this.sendHtml(res, renderRunBody({ ...this.project(runId), interactive: true, selectedSeq }));
            case "state.json":
              return this.sendJson(res, statusForRun(runId));
            case "trace.json": {
              const { status, traces } = this.project(runId);
              return this.sendJson(res, { status, traces: traces.map(boundTrace) });
            }
            case "events":
              return this.handleEvents(runId, req, res);
          }
        }
      } else if (req.method === "POST") {
        if (rest.length === 1 && rest[0] === "cancel") {
          appendControl(runId, { t: "cancel", atMs: Date.now() });
          res.writeHead(204).end();
          return;
        }
        if (rest.length === 2 && rest[0] === "approvals") {
          const approvalId = rest[1]!;
          if (!ID_RE.test(approvalId)) return this.sendText(res, 400, "invalid approval id");
          let parsed: { behavior?: unknown; message?: unknown };
          try {
            parsed = JSON.parse((await readBody(req)) || "{}") as typeof parsed;
          } catch {
            return this.sendText(res, 400, "invalid JSON body");
          }
          if (parsed.behavior !== "allow" && parsed.behavior !== "deny") {
            return this.sendText(res, 400, 'behavior must be "allow" or "deny"');
          }
          const msg: ControlMessage = {
            t: "approval",
            approvalId,
            decision: {
              behavior: parsed.behavior,
              ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
            },
            by: "ui",
            atMs: Date.now(),
          };
          appendControl(runId, msg);
          res.writeHead(204).end();
          return;
        }
      }
      return this.sendText(res, 404, "not found");
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`internal error: ${(err as Error).message}`);
    }
  }

  private project(runId: string): { manifest: ReturnType<typeof readManifest>; status: ReturnType<typeof statusForRun>; traces: TraceRecord[] } {
    return { manifest: readManifest(runId), status: statusForRun(runId), traces: readTraces(runId) };
  }

  // -------------------------------------------------------------------------
  // SSE: fs.watch on journal + traces (250ms debounce), 1500ms poll fallback.
  // Emits data: {"tick":n} on change; a final event + close once settled.
  // -------------------------------------------------------------------------
  private handleEvents(runId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(":ok\n\n");

    const paths = runPaths(runId);
    const watched = [paths.journal, paths.traces];
    let tickCount = 0;
    let closed = false;
    let debounce: NodeJS.Timeout | undefined;
    const watchers: fs.FSWatcher[] = [];
    let poll: NodeJS.Timeout | undefined;

    const settled = (): boolean => {
      try {
        return statusForRun(runId).state !== "running";
      } catch {
        return false;
      }
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (poll) clearInterval(poll);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      this.sseCleanups.delete(cleanup);
      try {
        res.end();
      } catch {
        /* socket gone */
      }
    };
    this.sseCleanups.add(cleanup);
    req.on("close", cleanup);

    const tick = (): void => {
      if (closed) return;
      tickCount++;
      res.write(`data: ${JSON.stringify({ tick: tickCount })}\n\n`);
      if (settled()) {
        res.write(`data: ${JSON.stringify({ tick: tickCount, final: true })}\n\n`);
        cleanup();
      }
    };

    if (settled()) {
      res.write(`data: ${JSON.stringify({ tick: 0, final: true })}\n\n`);
      cleanup();
      return;
    }

    const schedule = (): void => {
      if (closed || debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        tick();
      }, SSE_DEBOUNCE_MS);
    };

    for (const file of watched) {
      try {
        watchers.push(fs.watch(file, schedule));
      } catch {
        /* file missing — the poll fallback covers it */
      }
    }

    const snapshot = (): string =>
      watched
        .map((f) => {
          try {
            return String(fs.statSync(f).size);
          } catch {
            return "0";
          }
        })
        .join(":");
    let last = snapshot();
    poll = setInterval(() => {
      const cur = snapshot();
      if (cur !== last) {
        last = cur;
        schedule();
      }
    }, SSE_POLL_MS);
  }

  // -------------------------------------------------------------------------
  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private sendJson(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private sendText(res: http.ServerResponse, code: number, text: string): void {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  }
}
