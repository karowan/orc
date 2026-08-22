# Per-leaf context and file grants

The run-wide `brief` — a required, uniform string appended to every leaf's
system prompt — is replaced by an optional, two-level **context** channel,
plus a read-grant mechanism for files a launcher materializes on disk. Orc
transports; it never interprets.

- **`LaunchOptions.context`** (optional, opaque string) replaces `brief` and
  fans out to every leaf, as before. `brief` is removed outright — 0.1.x,
  no hand authors, meaning over back-compat — and the CLI/MCP `--brief`
  becomes an optional `--context`. The trace field renames to match.
- **`ThunkSpec.context`** (optional, opaque string) is the new per-leaf slot,
  authored by the program alongside `prompt`. `prompt` is the task; `context`
  is ambient background. There is no launcher-side per-leaf map: a launcher
  addressing program-internal leaf ids would couple it to identifiers it must
  not interpret.
- **Composition**: run-level first, then the thunk's, joined by a blank line —
  shared, then specific. The composed string rides `LeafRequest.context`
  verbatim for custom harnesses; `leafSystemPrompt` embeds it under a generic
  `CONTEXT:` label. When both slots are empty the section is omitted
  entirely. Delivery points are unchanged: claude system-prompt `append`,
  codex `developerInstructions`.
- **`LaunchOptions.readDirs`** (optional, run-level) declares directories the
  launcher has materialized files into and referenced from context text.
  The grant is read-only — never added to write roots — and means: these
  paths stay readable and inside every leaf's permission scope, so a leaf
  following a pointer never stalls on an approval prompt. claude maps them to
  `additionalDirectories`; codex needs no mapping today (every codex sandbox
  policy has full-disk read); the field is the durable slot if a harness ever
  confines reads. Relative entries resolve at launch. Materialization stays
  the launcher's job: it wrote the pointers, so it owns the paths and their
  lifetime.
- **No transport bound.** Context is carried verbatim; truncation is never
  performed, since it would corrupt exactly the text a launcher tuned under
  its own budget. An optional per-run `maxContextBytes` lets a launcher
  declare a cap against itself: a leaf whose composed context exceeds it
  fails at spec time with an error naming the leaf and both sizes. Absent,
  nothing is enforced — Orc never picks a number. The existing 4 KiB bound
  on the trace copy is a trace bound, not a transport bound, and remains.
- **The `settingSources: []` gap is closed by design, not mechanism.**
  Sandboxed write leaves keep settings isolation (settings can add writable
  roots), so they still see no repo agent files. The context channel is the
  intended carrier: a launcher that wants repo guidance in a leaf reads it
  itself and supplies it as context. Orc never reads a repo's agent files on
  a leaf's behalf — no hand-holding for repos that skip agentic setup.

## Considered options

- Structured context (a `{id, text}[]` document list). Rejected: structure
  Orc would carry but never branch on; the launcher already renders its own
  text, and opacity is the contract.
- Keeping the run-level slot required, as `brief` was. Rejected: an
  unopinionated transport doesn't insist every run has shared context; a
  launcher can keep an always-supply policy of its own.
- A built-in size cap, with rejection or truncation. Rejected: any number
  Orc picks is policy — model windows differ and the launcher owns the real
  budget. But the composed per-leaf total is only knowable in Orc (thunks
  are created dynamically by the running program), so the opt-in per-run cap
  keeps enforcement where the information is and the number where the policy
  is.
- Orc staging launcher-provided documents into the run directory. Rejected:
  pointers are written into context text before launch, so the launcher must
  know final paths pre-launch; staging would force path indirection or a
  pointer-rewrite step.
- Closing the settings gap by re-enabling `settingSources` ("project") or
  having the claude harness read repo agent files itself. Rejected: the
  first reopens the writable-roots hole; the second makes a harness
  reimplement one tool's file-discovery semantics.

## Consequences

- Rendering, relevance, and size policy live entirely in the launcher;
  Orc's contract is opaque strings, declared read grants, and an opt-in cap.
  The launcher's placement scheme can evolve without an Orc change.
- Programs gain a first-class way to give a leaf durable background without
  overloading `prompt`.
- Oversize without a declared cap fails at the model boundary like any other
  harness error, per leaf, after spend — that trade is the launcher's to
  make by setting `maxContextBytes` or not.
- Reads of granted files appear in the leaf trace as ordinary tool calls, so
  a launcher can mine the trace for which referenced files were actually
  read.
- Breaking change: `brief` disappears from `LaunchOptions`, `ThunkSpec`
  consumers, `LeafRequest`, the CLI, MCP schemas, and trace records in one
  release.
