#!/usr/bin/env node
/**
 * Fake `codex app-server` speaking the same newline JSON-RPC dialect as
 * codex-cli 0.144.x, scripted per scenario.
 *
 * Usage: node fake-app-server.mjs <scenario> <recordPath>
 *
 * Every client -> server message is appended (JSONL) to recordPath so tests
 * can assert exactly what the harness sent (thread/start params, approval
 * replies, turn/interrupt, ...).
 *
 * Scenarios:
 *   happy         command item + structured agent message + usage + completed
 *   approval      server requests item/commandExecution/requestApproval
 *   legacy-approval  server requests execCommandApproval (old family)
 *   edit-in-cwd   fileChange approval whose paths live under the thread cwd
 *   edit-out-cwd  fileChange approval with a path outside the thread cwd
 *   idle          responds to turn/start, then goes silent forever
 *   cancel        one delta, then waits for turn/interrupt
 *   discover      only initialize + model/list (for discover() tests)
 */
import { appendFileSync } from "node:fs";

const scenario = process.argv[2] ?? "happy";
const recordPath = process.argv[3];

let THREAD_ID = "thread-fake-1";
const TURN_ID = "turn-fake-1";
let threadCwd = "/tmp";
let approvalReplied = false;

function record(msg) {
  if (recordPath) appendFileSync(recordPath, JSON.stringify(msg) + "\n");
}
function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}
function notify(method, params) {
  send({ method, params });
}
let nextServerId = 1000;
const serverPending = new Map();
function serverRequest(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    serverPending.set(id, resolve);
    send({ id, method, params });
  });
}

function item(type, id, extra) {
  return { type, id, ...extra };
}
function emitItem(it) {
  notify("item/started", { threadId: THREAD_ID, turnId: TURN_ID, item: it, startedAtMs: Date.now() });
}
function completeItem(it) {
  notify("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: it, completedAtMs: Date.now() });
}
function agentMessage(text, { deltas = true } = {}) {
  const it = item("agentMessage", "msg-1", { text: "", phase: "final_answer" });
  emitItem(it);
  if (deltas) {
    const mid = Math.ceil(text.length / 2);
    for (const delta of [text.slice(0, mid), text.slice(mid)].filter(Boolean)) {
      notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta });
    }
  }
  completeItem({ ...it, text });
}
function usage() {
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: {
      total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 258400,
    },
  });
}
function turnCompleted(status, error = null) {
  notify("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: TURN_ID, items: [], itemsView: "notLoaded", status, error, startedAt: 1, completedAt: 2, durationMs: 1000 },
  });
}

async function driveTurn() {
  switch (scenario) {
    case "happy": {
      const cmd = item("commandExecution", "exec-1", {
        command: "/bin/zsh -lc 'echo hi'",
        cwd: threadCwd,
        status: "inProgress",
        commandActions: [],
      });
      emitItem(cmd);
      completeItem({ ...cmd, status: "completed", exitCode: 0 });
      agentMessage('{"ok":true,"n":2}');
      usage();
      turnCompleted("completed");
      break;
    }
    case "approval": {
      const cmd = item("commandExecution", "exec-1", {
        command: "/bin/zsh -lc 'touch marker.txt'",
        cwd: threadCwd,
        status: "inProgress",
      });
      emitItem(cmd);
      const resp = await serverRequest("item/commandExecution/requestApproval", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "exec-1",
        startedAtMs: Date.now(),
        command: "/bin/zsh -lc 'touch marker.txt'",
        cwd: threadCwd,
        reason: "needs write access",
        availableDecisions: ["accept", "cancel"],
      });
      approvalReplied = true;
      record({ note: "approval-response", response: resp });
      const accepted = resp?.decision === "accept";
      completeItem({ ...cmd, status: accepted ? "completed" : "declined", exitCode: accepted ? 0 : null });
      agentMessage(accepted ? "ran it" : "was declined");
      turnCompleted("completed");
      break;
    }
    case "legacy-approval": {
      const resp = await serverRequest("execCommandApproval", {
        conversationId: THREAD_ID,
        callId: "call-1",
        command: ["touch", "marker.txt"],
        cwd: threadCwd,
        parsedCmd: [],
      });
      record({ note: "approval-response", response: resp });
      agentMessage(resp?.decision === "approved" ? "ran it" : "was denied");
      turnCompleted("completed");
      break;
    }
    case "edit-in-cwd":
    case "edit-out-cwd": {
      const path =
        scenario === "edit-in-cwd" ? `${threadCwd}/notes/file.txt` : "/absolutely/elsewhere/file.txt";
      const fc = item("fileChange", "patch-1", {
        status: "inProgress",
        changes: [{ path, kind: "add" }],
      });
      emitItem(fc);
      const resp = await serverRequest("item/fileChange/requestApproval", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "patch-1",
        startedAtMs: Date.now(),
      });
      record({ note: "approval-response", response: resp });
      const accepted = resp?.decision === "accept";
      completeItem({ ...fc, status: accepted ? "completed" : "declined" });
      agentMessage(accepted ? "edited" : "edit declined");
      turnCompleted("completed");
      break;
    }
    case "idle":
      // Say nothing, forever. The harness's idle watchdog must kill us.
      break;
    case "cancel": {
      notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta: "working..." });
      // Now wait: turn/interrupt handling lives in the main dispatcher.
      break;
    }
    default:
      agentMessage(`unknown scenario ${scenario}`);
      turnCompleted("completed");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    record(msg);
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  // Response to one of our server -> client requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = serverPending.get(msg.id);
    if (resolve) {
      serverPending.delete(msg.id);
      resolve(msg.result ?? msg.error);
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { userAgent: "fake-app-server/0.144.5" } });
      break;
    case "initialized":
      break;
    case "model/list":
      send({
        id: msg.id,
        result: {
          data: [
            {
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "low",
            },
            {
              id: "gpt-5.6-luna",
              model: "gpt-5.6-luna",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }],
              defaultReasoningEffort: "medium",
            },
            { id: "gpt-hidden", model: "gpt-hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [] },
          ],
          nextCursor: null,
        },
      });
      break;
    case "thread/start":
      threadCwd = msg.params?.cwd ?? threadCwd;
      send({ id: msg.id, result: { thread: { id: THREAD_ID }, model: "gpt-5.6-sol", modelProvider: "openai" } });
      notify("thread/started", { thread: { id: THREAD_ID } });
      break;
    case "thread/resume":
      threadCwd = msg.params?.cwd ?? threadCwd;
      THREAD_ID = msg.params?.threadId ?? THREAD_ID;
      send({ id: msg.id, result: { thread: { id: THREAD_ID }, model: "gpt-5.6-sol" } });
      break;
    case "turn/start":
      send({ id: msg.id, result: { turn: { id: TURN_ID, items: [], status: "inProgress" } } });
      driveTurn().catch(() => {});
      break;
    case "turn/interrupt":
      send({ id: msg.id, result: {} });
      turnCompleted("interrupted");
      break;
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
  }
}
