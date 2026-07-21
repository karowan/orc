/**
 * The orc authoring + usage guide. One source of truth surfaced by:
 *  - CLI:  `orc guide`
 *  - MCP:  the `orc_guide` tool
 */
export const GUIDE = `# orc — how to write and run a program

orc runs a "program": a script that fans out AI-agent subtasks ("leaves") and
records each one, so a run is reproducible, resumable, and observable. You write
a program, launch it, then watch it and collect the result.

## 1. Write a program

A program is a \`.orc.ts\` file with a single default-exported async function.
It receives an api object and returns the run's result:

    import type { Program } from "@orc/sdk/program"; // optional, type-only

    const program: Program = async ({ agent, parallel, phase }) => {
      const inventory = await agent("List the modules in this repo.", {
        schema: { type: "object",
                  properties: { modules: { type: "array", items: { type: "string" } } },
                  required: ["modules"] },
      });

      // Ordinary async/await controls the flow. Awaiting a result before the
      // next call makes it a dependency; independent calls run concurrently.
      const plans = await Promise.all((inventory.modules as string[]).map(async (m) => {
        const findings = await agent(\`Audit module \${m}\`, { id: \`audit-\${m}\` });
        return agent(\`Plan a fix for \${m}: \${JSON.stringify(findings)}\`, { id: \`plan-\${m}\` });
      }));

      return phase("synthesis", () => agent(\`Merge these plans: \${JSON.stringify(plans)}\`, { id: "merge" }));
    };
    export default program;

## The api

IMPORTANT — leaves are isolated. Each agent() runs a FRESH subagent that shares
NONE of your context: it cannot see this program, your conversation, other
leaves' prompts or results, or anything you know that you haven't written into
its prompt (plus the shared \`--brief\`).

- agent(prompt, opts?) => Promise<result>
    Dispatch one agent. Returns its result (matching \`schema\` if you pass one).
    A failed leaf rejects the promise, so wrap it in try/catch if you want to
    handle failure. Options:
      id               a label shown in the monitor
      schema           JSON Schema; the result is structured output matching it
      harness          "claude" | "codex" | a configured harness (default: auto)
      model            e.g. "claude-fable-5", "gpt-5.6-sol"
      reasoningEffort  "low" | "medium" | "high" | "xhigh" | "max"
      readOnly         default true; set false for a leaf that edits files
      cwd              working directory for this leaf (defaults to the run's)
      idleTimeout      ms with no output before the leaf is killed (false = off)
      phase            group this call under a phase label
    To see valid \`harness\`, \`model\`, and \`reasoningEffort\` values for your
    machine, run \`orc capabilities\` (or \`orc capabilities --json\`) — it lists
    each installed harness with its available models and reasoning levels.
    Omit any of them to use the default; an unknown value is rejected up front
    by \`orc validate\`.

- parallel(specs[]) => Promise<outcomes[]>
    Run several agents at once from an array of option objects (each with a
    \`prompt\`). Every lane runs to completion INDEPENDENTLY — one lane failing
    never cancels the others. Outcomes come back in order as
    \`{ status: "ok", value } | { status: "error", error }\`, so you decide how to
    handle partial failure. (For fail-fast, use \`Promise.all\` over \`agent()\`,
    which rejects on the first failure.)

- phase(name, fn) => Promise<result>
    Group every agent() call made inside \`fn\` under a phase, for a readable
    run timeline.

- settle(promise) => { status: "ok", value } | { status: "error", error }
    Run a lane and capture its outcome instead of letting a failure stop the run
    — useful for "do all of these, some may fail" fan-outs.

- log(message)  — write a line to the run's live event feed.
- ext.<name>(payload) — call a custom step you registered in orc.config.

Because leaves can't see each other, pass data between them as plain values:
put a previous result into the next prompt with JSON.stringify so the receiving
leaf actually has it. Use normal try/catch, Promise.all/allSettled, and bounded
loops for control flow.

## What a program may and may not do

- No wall clock or randomness. \`Date\`, \`Math.random\`, timers, network, file
  access, and imports (beyond type-only) are unavailable — a program only
  decides which agents to run and how to combine their results.
- Loops must be finite; an unbounded loop is stopped by a step limit.
- These constraints let orc replay a program exactly when you resume it, so the
  same inputs always produce the same run.

## Writing files

By default leaves are read-only. To let a leaf directly modify files or run
mutating commands, set \`readOnly: false\` and launch the run with
\`--allow-writes\`. Configured hooks and MCP tools are not disabled for read-only
leaves; their side effects are outside this guarantee. A write leaf runs with
whatever permissions your own agent has; add \`--sandbox\` to confine its writes
to the working directory. If a run stops on a write leaf, \`orc resume\` picks it
back up (it re-checks the working-tree state first, never blindly redoing work).

## 2. Validate and launch

    orc validate --program-path ./my.orc.ts       # compile + preview, no run
    orc launch   --program-path ./my.orc.ts --brief "what this run is for"

\`--brief\` (required) is shared context added to every leaf. Common launch flags:
\`--allow-writes\`, \`--approval-mode manual|accept-edits|auto|bypass\`,
\`--sandbox\`, \`--harness claude|codex\`, \`--budget <usd>\` (fail the run after
observed estimated cost exceeds this; concurrent work may overshoot), \`--wait\`
(block for the result instead of running in the background).

## 3. Watch and collect

    orc status     --run-id <id>       # summary
    orc wait       --run-id <id>       # block until it finishes
    orc get-result --run-id <id>       # the final result (or --seq N for one leaf)
    orc trace      --run-id <id>       # per-leaf and per-tool detail
    orc open       --run-id <id>       # open the live monitor, print its URL
    orc list                           # recent runs

## 4. Approvals

In \`manual\` or \`accept-edits\` mode a leaf can pause to ask permission for a
tool. Answer it from anywhere:

    orc approvals --run-id <id>
    orc respond   --run-id <id> --approval-id <aid> --behavior allow|deny

## Discover more

    orc --help                 # every command
    orc <command> --help       # a command's flags
    orc commands               # JSON catalog of all operations
    orc capabilities           # available harnesses, models, and reasoning levels
    orc doctor                 # check this machine is ready

Every command supports \`--json\`. Run state lives in \`$ORC_HOME\` (default
\`~/.orc\`). Real runs need \`claude\` and/or \`codex\` installed and logged in.
`;
