import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlMessage, RunStatus } from "@orc/core/src/contracts.js";
import { MonitorServer, portForHome } from "../src/index.js";
import { waitFor, writeRunDir, type FixtureRun } from "./fixtures.js";

describe("MonitorServer", () => {
  let home: string;
  let prevHome: string | undefined;
  let server: MonitorServer;
  let url: string;
  let port: number;
  let run: FixtureRun;

  beforeEach(async () => {
    prevHome = process.env.ORC_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-ui-server-"));
    process.env.ORC_HOME = home;
    run = writeRunDir("r_srv_run1");
    server = new MonitorServer();
    ({ url, port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
    if (prevHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function readControl(): ControlMessage[] {
    return fs
      .readFileSync(run.controlPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ControlMessage);
  }

  it("starts on the deterministic port (or a nearby fallback) bound to loopback", () => {
    const base = portForHome(home);
    expect(port).toBeGreaterThanOrEqual(base);
    expect(port).toBeLessThanOrEqual(base + 20);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(server.urlForRun(run.runId)).toBe(`${url}/runs/${run.runId}`);
  });

  it("serves a run index at /", async () => {
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/runs/${run.runId}`);
    expect(html).toContain("demo run");
  });

  it("identifies the monitor and its state home on the health endpoint", async () => {
    const res = await fetch(`${url}/health.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "orc-monitor", home });
  });

  it("serves projected status at /runs/:id/state.json", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/state.json`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as RunStatus;
    expect(status.runId).toBe(run.runId);
    expect(status.state).toBe("running");
    expect(status.totalCalls).toBe(3);
    expect(status.ok).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.running).toBe(1);
    expect(status.approvalsPending).toBe(1);
  });

  it("serves the live page with SSE script and working approval buttons", async () => {
    const res = await fetch(`${url}/runs/${run.runId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="app"');
    expect(html).toContain("EventSource");
    expect(html).toContain("orcApprove('appr_1','allow')");
    expect(html).toContain("orcApprove('appr_1','deny')");
  });

  it("serves a body fragment at /runs/:id/fragment", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/fragment`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("agent#1");
    expect(html).toContain("1 GATE OPEN");
    expect(html).not.toContain("<!doctype");
  });

  it("serves bounded traces at /runs/:id/trace.json", async () => {
    // append an oversized prompt trace
    const big = "x".repeat(64 * 1024);
    fs.appendFileSync(
      run.tracesPath,
      JSON.stringify({
        t: "leaf", seq: 3, attempt: 1, rev: 2, status: "error", kind: "agent",
        readOnly: true, startMs: Date.now(), endMs: Date.now(), prompt: big, error: "still exploded",
      }) + "\n",
    );
    const res = await fetch(`${url}/runs/${run.runId}/trace.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: RunStatus; traces: Array<{ t: string; prompt?: string }> };
    expect(body.status.runId).toBe(run.runId);
    const bounded = body.traces.find((t) => t.prompt?.includes("[truncated:"));
    expect(bounded).toBeDefined();
    expect(bounded!.prompt!.length).toBeLessThan(20 * 1024);
  });

  it("POST /runs/:id/approvals/:approvalId appends an approval control message", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/approvals/appr_1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(204);
    const msgs = readControl();
    expect(msgs).toHaveLength(1);
    const msg = msgs[0]!;
    expect(msg.t).toBe("approval");
    if (msg.t !== "approval") throw new Error("unreachable");
    expect(msg.approvalId).toBe("appr_1");
    expect(msg.decision).toEqual({ behavior: "allow" });
    expect(msg.by).toBe("ui");
    expect(typeof msg.atMs).toBe("number");
  });

  it("POST deny with message carries the message through", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/approvals/appr_1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior: "deny", message: "not on my watch" }),
    });
    expect(res.status).toBe(204);
    const msg = readControl()[0]!;
    if (msg.t !== "approval") throw new Error("expected approval message");
    expect(msg.decision).toEqual({ behavior: "deny", message: "not on my watch" });
  });

  it("rejects a bad approval behavior", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/approvals/appr_1`, {
      method: "POST",
      body: JSON.stringify({ behavior: "maybe" }),
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(run.controlPath)).toBe(false);
  });

  it("POST /runs/:id/cancel appends a cancel control message", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(204);
    const msg = readControl()[0]!;
    expect(msg.t).toBe("cancel");
    if (msg.t !== "cancel") throw new Error("unreachable");
    expect(typeof msg.atMs).toBe("number");
  });

  it("validates run id segments and 404s unknown runs", async () => {
    expect((await fetch(`${url}/runs/bad$id/state.json`)).status).toBe(400);
    expect((await fetch(`${url}/runs/${encodeURIComponent("../escape")}/state.json`)).status).toBe(400);
    expect((await fetch(`${url}/runs/r_no_such_run/state.json`)).status).toBe(404);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it("SSE emits a tick on trace append and closes once the run settles", async () => {
    const res = await fetch(`${url}/runs/${run.runId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    let buffer = "";
    let streamClosed = false;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      streamClosed = true;
    })();

    // a trace append must produce a tick within ~2s (250ms debounce + watch)
    fs.appendFileSync(
      run.tracesPath,
      JSON.stringify({ t: "event", atMs: Date.now(), event: { kind: "log", message: "poke" } }) + "\n",
    );
    await waitFor(() => buffer.includes('"tick"'), 2_000, "first SSE tick");

    // settling the run must produce a final event and close the stream
    fs.appendFileSync(run.journalPath, JSON.stringify({ t: "finish", status: "completed" }) + "\n");
    await waitFor(() => streamClosed, 4_000, "SSE stream close after settle");
    expect(buffer).toContain('"final":true');
    await pump;
  });

  it("SSE closes immediately for an already-settled run", async () => {
    const settled = writeRunDir("r_srv_done", { settled: true });
    const res = await fetch(`${url}/runs/${settled.runId}/events`);
    const text = await res.text(); // resolves only when the server ends the stream
    expect(text).toContain('"final":true');
  });
});
