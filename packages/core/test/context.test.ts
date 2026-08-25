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
