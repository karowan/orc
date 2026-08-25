import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRun, superviseRun } from "../src/supervisor.js";
import { readManifest, readResult, runPaths } from "../src/rundir.js";
import type { LeafRequest } from "../src/contracts.js";
import { makeFakeHarness, makeRegistry } from "./helpers/fake.js";

const FIX = (name: string) => path.join(__dirname, "fixtures", name);
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-read-dirs-"));
  process.env.ORC_HOME = home;
});

/** The fake harness echoes the grant the leaf actually received. */
const echoRegistry = () =>
  makeRegistry(
    makeFakeHarness({
      result: (req: LeafRequest) => req.readDirs ?? null,
    }),
  );

async function grantSeenBySoleLeaf(extra: Record<string, unknown> = {}) {
  const registry = echoRegistry();
  const manifest = await prepareRun(
    { programPath: FIX("context-none.orc.ts"), cwd: home, ...extra },
    registry,
  );
  const status = await superviseRun(manifest.runId, registry);
  expect(status.state).toBe("completed");
  return {
    manifest,
    seen: readResult(runPaths(manifest.runId), status.resultSha!) as string[] | null,
  };
}

describe("readDirs launch resolution", () => {
  it("resolves relative entries against the caller's cwd, preserving order", async () => {
    const manifest = await prepareRun(
      { programPath: FIX("context-none.orc.ts"), cwd: home, readDirs: ["rel/docs", "/abs/docs"] },
      echoRegistry(),
    );
    expect(manifest.readDirs).toEqual([path.resolve("rel/docs"), "/abs/docs"]);
    expect(readManifest(manifest.runId).readDirs).toEqual([path.resolve("rel/docs"), "/abs/docs"]);
  });

  it("passes a nonexistent entry through without failing the launch", async () => {
    const missing = path.join(home, "never-materialized");
    const manifest = await prepareRun(
      { programPath: FIX("context-none.orc.ts"), cwd: home, readDirs: [missing] },
      echoRegistry(),
    );
    // Materialization is the launcher's job: orc resolves paths, nothing more.
    expect(manifest.readDirs).toEqual([missing]);
  });

  it("carries an explicit empty list through as no grant", async () => {
    const manifest = await prepareRun(
      { programPath: FIX("context-none.orc.ts"), cwd: home, readDirs: [] },
      echoRegistry(),
    );
    expect(manifest.readDirs).toEqual([]);
  });

  it("omits the key entirely when the option is not supplied", async () => {
    const { manifest, seen } = await grantSeenBySoleLeaf();
    expect(seen).toBe(null);
    expect(readManifest(manifest.runId).readDirs).toBeUndefined();
    expect(
      "readDirs" in
        (JSON.parse(fs.readFileSync(runPaths(manifest.runId).manifest, "utf8")) as object),
    ).toBe(false);
  });
});

describe("readDirs delivery", () => {
  it("delivers the launch-resolved list to the leaf on LeafRequest.readDirs", async () => {
    const { seen } = await grantSeenBySoleLeaf({ readDirs: ["rel/docs", "/abs/docs"] });
    expect(seen).toEqual([path.resolve("rel/docs"), "/abs/docs"]);
  });
});
