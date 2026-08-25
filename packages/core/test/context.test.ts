import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  composeContext,
  leafSystemPrompt,
  prepareRun,
  superviseRun,
} from "../src/supervisor.js";
import { readJournal, readManifest, readResult, readTraces, runPaths } from "../src/rundir.js";
import type { LeafRequest } from "../src/contracts.js";
import { makeFakeHarness, makeRegistry } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-context-"));
  process.env.ORC_HOME = home;
});

/** What the harness actually saw on the leaf request. */
interface Seen {
  context: string | null;
  system: string;
}

const echoRegistry = () =>
  makeRegistry(
    makeFakeHarness({
      result: (req: LeafRequest): Seen => ({ context: req.context ?? null, system: req.system }),
    }),
  );

async function runProgram(program: string, extra: Record<string, unknown> = {}) {
  const registry = echoRegistry();
  const manifest = await prepareRun({ programPath: FIX(program), cwd: home, ...extra }, registry);
  const status = await superviseRun(manifest.runId, registry);
  expect(status.state).toBe("completed");
  return { manifest, status };
}

/** The single-leaf fixtures return the leaf's result directly. */
async function seenBySoleLeaf(program: string, extra: Record<string, unknown> = {}) {
  const { manifest, status } = await runProgram(program, extra);
  return {
    manifest,
    seen: readResult(runPaths(manifest.runId), status.resultSha!) as unknown as Seen,
  };
}

describe("composeContext", () => {
  it("joins run-level then thunk context with a blank line", () => {
    expect(composeContext("run", "leaf")).toBe("run\n\nleaf");
  });

  it("includes only the non-empty slots", () => {
    expect(composeContext("run", undefined)).toBe("run");
    expect(composeContext(undefined, "leaf")).toBe("leaf");
    expect(composeContext(undefined, undefined)).toBe("");
  });

  it("treats a whitespace-only slot as empty but carries participants verbatim", () => {
    expect(composeContext("  \n ", "leaf")).toBe("leaf");
    expect(composeContext("run", "\t")).toBe("run");
    // a participating slot's own whitespace is never trimmed away
    expect(composeContext(" run\n", " leaf ")).toBe(" run\n\n\n leaf ");
  });
});

describe("leafSystemPrompt", () => {
  it("omits the context section entirely when there is none", () => {
    const system = leafSystemPrompt(true, "/w", "");
    expect(system).not.toContain("CONTEXT:");
    expect(system).not.toContain("SHARED CONTEXT");
    expect(system.endsWith("change system state.")).toBe(true); // no trailing newline artifact
  });

  it("embeds a composed context under a generic label", () => {
    const system = leafSystemPrompt(false, "/w", "run\n\nleaf");
    expect(system).toContain("Working directory: /w");
    expect(system.endsWith("\nCONTEXT:\nrun\n\nleaf")).toBe(true);
  });
});

describe("context delivery", () => {
  it("a run with no context anywhere shows the leaf no context heading", async () => {
    const { manifest, seen } = await seenBySoleLeaf("context-none.orc.ts");
    expect(seen.context).toBe(null);
    expect(seen.system).not.toContain("CONTEXT:");
    expect(seen.system).not.toContain("SHARED CONTEXT");
    // absent-if-undefined on disk, and no trace copy either
    expect(readManifest(manifest.runId).context).toBeUndefined();
    expect("context" in (JSON.parse(fs.readFileSync(runPaths(manifest.runId).manifest, "utf8")) as object)).toBe(false);
    const leaves = readTraces(manifest.runId).filter((t) => t.t === "leaf");
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((t) => t.t === "leaf" && t.context === undefined)).toBe(true);
  });

  it("run-level context reaches the leaf under the CONTEXT: label", async () => {
    const { manifest, seen } = await seenBySoleLeaf("context-none.orc.ts", { context: "run ctx" });
    expect(seen.context).toBe("run ctx");
    expect(seen.system).toContain("CONTEXT:\nrun ctx");
    expect(readManifest(manifest.runId).context).toBe("run ctx");
  });

  it("per-leaf context alone reaches the leaf verbatim", async () => {
    const { seen } = await seenBySoleLeaf("context-leaf.orc.ts");
    expect(seen.context).toBe(" leaf ctx ");
    expect(seen.system).toContain("CONTEXT:\n leaf ctx ");
  });

  it("composes shared then specific, blank-line joined", async () => {
    const { manifest, seen } = await seenBySoleLeaf("context-leaf.orc.ts", { context: "run ctx" });
    expect(seen.context).toBe("run ctx\n\n leaf ctx ");
    expect(seen.system).toContain("CONTEXT:\nrun ctx\n\n leaf ctx ");
    const leaf = readTraces(manifest.runId).find((t) => t.t === "leaf");
    expect(leaf?.t === "leaf" && leaf.context).toBe("run ctx\n\n leaf ctx ");
  });

  it("whitespace-only slots compose to nothing", async () => {
    const { seen } = await seenBySoleLeaf("context-blank.orc.ts", { context: "   " });
    expect(seen.context).toBe(null);
    expect(seen.system).not.toContain("CONTEXT:");
  });

  it("parallel lanes carry their own context beside the shared one", async () => {
    const { manifest, status } = await runProgram("context-lanes.orc.ts", { context: "run ctx" });
    const lanes = readResult(runPaths(manifest.runId), status.resultSha!) as unknown as Array<{
      status: string;
      value: Seen;
    }>;
    expect(lanes.map((l) => l.status)).toEqual(["ok", "ok"]);
    expect(lanes[0].value.context).toBe("run ctx\n\nlane A");
    expect(lanes[1].value.context).toBe("run ctx");
  });

  it("transports oversize context verbatim while the trace copy stays bounded", async () => {
    const big = "x".repeat(5000);
    const { manifest, seen } = await seenBySoleLeaf("context-none.orc.ts", { context: big });
    expect(seen.context).toBe(big); // no truncation on the transport path
    const leaf = readTraces(manifest.runId).find((t) => t.t === "leaf");
    const traced = leaf?.t === "leaf" ? leaf.context! : "";
    expect(traced).not.toBe(big);
    expect(traced.startsWith("x".repeat(4 * 1024))).toBe(true);
    expect(traced).toContain("(truncated");
  });

  it("per-leaf context participates in the spec digest and replays from the journal", async () => {
    const digestOf = async (program: string) => {
      const { manifest } = await runProgram(program);
      const call = readJournal(manifest.runId).find((r) => r.t === "call");
      return { manifest, digest: call?.t === "call" ? call.specDigest : undefined };
    };
    const plain = await digestOf("context-none.orc.ts");
    const withContext = await digestOf("context-leaf.orc.ts");
    expect(plain.digest).toBeDefined();
    expect(withContext.digest).not.toBe(plain.digest);

    // Crash-before-finish, then pure replay: no leaf may be re-dispatched.
    const paths = runPaths(withContext.manifest.runId);
    const records = readJournal(withContext.manifest.runId).filter((r) => r.t !== "finish");
    fs.writeFileSync(paths.journal, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const poisoned = makeRegistry(
      makeFakeHarness({
        result: () => {
          throw new Error("leaf re-dispatched during pure replay");
        },
      }),
    );
    const resumed = await superviseRun(withContext.manifest.runId, poisoned);
    expect(resumed.state).toBe("completed");
  });
});

describe("maxContextBytes", () => {
  /**
   * Run to whatever terminal state (no completion assertion), with a harness
   * that logs every invocation — an empty log is proof at the dispatch boundary.
   */
  async function runCapped(program: string, extra: Record<string, unknown> = {}) {
    const invocationLog = path.join(home, "invocations.log");
    const registry = makeRegistry(
      makeFakeHarness({
        invocationLog,
        result: (req: LeafRequest): Seen => ({ context: req.context ?? null, system: req.system }),
      }),
    );
    const manifest = await prepareRun({ programPath: FIX(program), cwd: home, ...extra }, registry);
    const status = await superviseRun(manifest.runId, registry);
    return {
      manifest,
      status,
      invocations: fs.existsSync(invocationLog)
        ? fs.readFileSync(invocationLog, "utf8").split("\n").filter(Boolean)
        : [],
      /** The first errored leaf trace, which carries the bounded failure message. */
      errored: readTraces(manifest.runId).find((t) => t.t === "leaf" && t.status === "error"),
      sole: () => readResult(runPaths(manifest.runId), status.resultSha!) as unknown as Seen,
      tracedContext: () => {
        const leaf = readTraces(manifest.runId).find((t) => t.t === "leaf");
        return leaf?.t === "leaf" ? (leaf.context ?? "") : "";
      },
    };
  }

  it("fails an oversize leaf at spec time, naming its sequence and both byte sizes", async () => {
    const { manifest, status, invocations, errored, tracedContext } = await runCapped(
      "context-none.orc.ts",
      { context: "x".repeat(5000), maxContextBytes: 2048 },
    );
    expect(status.state).toBe("failed");
    const seq = errored?.t === "leaf" ? errored.seq : undefined;
    const error = errored?.t === "leaf" ? (errored.error ?? "") : "";
    expect(seq).toBeDefined();
    expect(error).toContain(`leaf ${seq}`); // no authored id → the sequence
    expect(error).toContain("5000"); // composed size
    expect(error).toContain("2048"); // configured cap
    expect(status.error).toContain("5000");
    expect(status.error).toContain("2048");
    // Never dispatched, on any attempt: no harness invocation, so no model spend.
    expect(invocations).toEqual([]);
    expect(readJournal(manifest.runId).some((r) => r.t === "done" && r.status === "ok")).toBe(false);
    // A cap below 4 KiB does not tighten the trace-copy bound.
    expect(tracedContext().startsWith("x".repeat(4 * 1024))).toBe(true);
    expect(tracedContext()).toContain("(truncated");
  });

  it("names the leaf by its authored id when the program set one", async () => {
    const { status, invocations, errored } = await runCapped("context-id.orc.ts", {
      maxContextBytes: 8,
    });
    expect(status.state).toBe("failed");
    const error = errored?.t === "leaf" ? (errored.error ?? "") : "";
    expect(error).toContain('leaf "capped"');
    expect(error).toContain("64");
    expect(error).toContain("8");
    expect(invocations).toEqual([]);
  });

  it("delivers a composed context exactly equal to the cap", async () => {
    const ctx = "run ctx\n\n leaf ctx ";
    const { status, invocations, sole } = await runCapped("context-leaf.orc.ts", {
      context: "run ctx",
      maxContextBytes: Buffer.byteLength(ctx, "utf8"),
    });
    expect(status.state).toBe("completed"); // strictly greater fails; equal passes
    expect(sole().context).toBe(ctx);
    expect(invocations.length).toBe(1);
  });

  it("measures UTF-8 bytes, not code units", async () => {
    const ctx = "🙂".repeat(100);
    expect(ctx.length).toBe(200); // a code-unit measurement would pass a cap of 300
    const { status, errored } = await runCapped("context-none.orc.ts", {
      context: ctx,
      maxContextBytes: 300,
    });
    expect(status.state).toBe("failed");
    const error = errored?.t === "leaf" ? (errored.error ?? "") : "";
    expect(error).toContain("400");
    expect(error).toContain("300");
  });

  it("leaves the 4 KiB trace-copy bound alone when the cap is well above it", async () => {
    const big = "x".repeat(5000);
    const { status, sole, tracedContext } = await runCapped("context-none.orc.ts", {
      context: big,
      maxContextBytes: 16 * 1024,
    });
    expect(status.state).toBe("completed");
    expect(sole().context).toBe(big); // transport still verbatim
    expect(tracedContext()).not.toBe(big);
    expect(tracedContext().startsWith("x".repeat(4 * 1024))).toBe(true);
    expect(tracedContext()).toContain("(truncated");
  });

  it("rejects a cap that is not a positive integer, before any run directory exists", async () => {
    const registry = echoRegistry();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        prepareRun(
          { programPath: FIX("context-none.orc.ts"), cwd: home, maxContextBytes: bad },
          registry,
        ),
      ).rejects.toThrow("maxContextBytes must be a positive integer");
    }
    expect(fs.existsSync(path.join(home, "runs"))).toBe(false);
  });

  it("carries a valid cap into the manifest and omits the key when unset", async () => {
    const registry = echoRegistry();
    const opts = { programPath: FIX("context-none.orc.ts"), cwd: home };
    const capped = await prepareRun({ ...opts, maxContextBytes: 1024 }, registry);
    expect(readManifest(capped.runId).maxContextBytes).toBe(1024);
    const uncapped = await prepareRun(opts, registry);
    const onDisk = JSON.parse(
      fs.readFileSync(runPaths(uncapped.runId).manifest, "utf8"),
    ) as object;
    expect("maxContextBytes" in onDisk).toBe(false);
  });
});
