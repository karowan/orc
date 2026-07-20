# orc

A lightweight TypeScript orchestration runtime — a port of the Go `factory.orchestrate`
engine. Model-authored **promise-native** programs whose `agent()` calls become
journaled, run-once leaf executions, with deterministic replay/resume, live
monitoring, per-call SSH-remote working directories, and pluggable harnesses.
No Temporal, no daemon, no database.

## The idea

An orc program is a TypeScript file with one default-exported async function. It
runs in a deterministic sandbox (QuickJS, sync build) and drives real agent work:

```ts
import type { Program } from "@orc/sdk/program";

const program: Program = async ({ agent, parallel, phase }) => {
  const inventory = await agent("List this repo's modules.", {
    schema: { type: "object", properties: { modules: { type: "array", items: { type: "string" } } }, required: ["modules"] },
  });

  // Completion-time edges are just promises — no graph API. Each module's plan
  // starts the moment ITS OWN audit finishes, not at a wave barrier.
  const plans = await Promise.all((inventory.modules as string[]).map(async (m) => {
    const findings = await agent(`Audit ${m}`, { id: `audit-${m}` });
    return agent(`Plan remediation for ${m}: ${JSON.stringify(findings)}`, { id: `plan-${m}` });
  }));

  return phase("synthesis", () =>
    agent(`Merge these plans: ${JSON.stringify(plans)}`, {
      host: "build-box", cwd: "/srv/repo", readOnly: false, // a remote write leaf
    }));
};
export default program;
```

The dependency graph *is* the promise structure. Data flows between leaves as
ordinary values (`JSON.stringify` a result into the next prompt). There is no
`runGraph` / `task` API and no wave engine.

## Architecture

The canonical rationale, invariants, and accepted tradeoffs live in
[DESIGN.html](./DESIGN.html).

| Package | Role |
|---|---|
| `@orc/core` | The engine: QuickJS deterministic event loop, sequence identity, journal (WAL) + trace sidecar, content-addressed results, scheduler (`maxParallel`), policy caps, replay + fail-forward resume, supervisor. |
| `@orc/executors` | `LocalExecutor` (process groups) and `SshExecutor` (system `ssh`, honours `~/.ssh/config`). One `Executor` interface; `cwd` and `host` are separate fields. |
| `@orc/harness-claude` | Built-in harness: Anthropic Agent SDK locally, claude CLI stream-json over ssh for remote hosts. |
| `@orc/harness-codex` | Built-in harness: `codex app-server` JSON-RPC, run through the executor so it works locally **and** over ssh unchanged. |
| `@orc/ops` | The zod-first operation registry — canonical definitions for registry-backed commands and tools. Plus registry assembly (zero-config built-ins). |
| `@orc/cli` | `orc …` — every command is a runtime interpretation of the registry (flags, help, `orc commands --json` all derived). |
| `@orc/mcp` | stdio MCP server; the same ops as tools, zod schemas native, `readOnlyHint` discipline. |
| `@orc/sdk` | Embedded TypeScript SDK (`new Orc().launch(...)`, `run.watch()`), input types via `z.input`; plus `@orc/sdk/program` for authors. |
| `@orc/ui` | Trace projection → self-contained `report.html` + a live SSE waterfall server. |

## Determinism & durability (no Temporal)

- **Replay** = re-execute the frozen program, delivering journaled completions in
  recorded order (one per quiescent drain), until it catches up, then continue live.
- **WAL invariant**: a completion is fsynced to `journal.jsonl` *before* it is
  delivered into the sandbox.
- **Bidirectional divergence detection**: a changed call digest, a dangling
  journaled completion, an unconsumed suffix, or a tampered program bundle all
  fail the resume loudly.
- **Sandbox** actively strips `Date`, `Math.random`, `WeakRef`,
  `FinalizationRegistry`; step budget is an interrupt-invocation count per turn.
- **Fail-forward resume**: a run that died on a write leaf is resumable. Write
  leaves are never blindly re-run — a resume re-dispatches them as a *re-orienting*
  attempt (a `git status`/`diff` snapshot is prepended, with an idempotent-completion
  instruction). No rewind.
- Replay across orc **version upgrades** is unsupported by design (YAGNI) — the
  divergence detector catches it rather than any versioning machinery.

## CLI

```
orc launch --program-path p.orc.ts --brief "..." [--host frank --cwd /path] [--allow-writes] [--wait]
orc validate --program-path p.orc.ts    # compile + first-frontier preview, no run
orc status --run-id <id>                 # body-free projection
orc wait --run-id <id> --timeout-seconds 300
orc get-result --run-id <id> [--seq N]
orc resume --run-id <id> [--wait]        # fail-forward, re-orients write leaves
orc capabilities [--host frank]          # harnesses → models → efforts, natively discovered
orc doctor --host frank --cwd /path      # preflight binaries/versions/cwd
orc open --run-id <id> [--browser]       # ensure the monitor, print the URL
orc report --run-id <id>                 # (re)write report.html
orc ui                                   # foreground live monitor
orc mcp                                  # stdio MCP server
orc commands                             # machine-readable op catalog (for agents)
```

Every command supports `--json`.

## Approval modes (generic, mapped per harness)

`manual | accept-edits | auto | bypass` are orc-level semantics; each harness maps
them natively (claude `permissionMode` incl. `dontAsk` for `auto`; codex
`approvalPolicy`/sandbox). Pending approvals bubble into the monitor, CLI
(`orc approvals` / `orc respond`), MCP, and `run.watch()`. Default substrate is the
user's own settings (claude `settingSources`, codex `~/.codex/config.toml`).
`readOnly` blocks built-in command and file-mutation tools but deliberately does
not disable configured hooks and MCPs such as Computer Use; their side effects
are outside that guarantee.

## Config (optional)

Zero config runs claude + codex, discovered natively. An optional `orc.config.js`
registers **custom** harnesses (package or NDJSON executable) and **runtime
extensions** (`defineLeaf(...)` — journaled leaf kinds callable as `ext.name()`).
There is deliberately no ambient plugin scanning.

## Development

```
npm install
npx vitest run                          # unit + determinism + kill-9 + MCP stdio
# live (gated):
ORC_CODEX_LIVE=1 ORC_CLAUDE_LIVE=1 ORC_SSH_TEST_HOST=frank npx vitest run
```

Status: v0.1 — full pipeline works end to end (local + ssh, both harnesses,
write leaves, resume, monitor). See `examples/smoke.orc.ts`.
