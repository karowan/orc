/**
 * validate's structure hint: when the whole first frontier is one parallel()
 * group, everything the program awaits next waits for the slowest lane. The
 * hint is advice for the author, never a validation failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Harness, HarnessCapabilities, Registry } from "@karowanorg/orc-core";
import { LocalExecutor } from "@karowanorg/orc-executors";
import { validate, type OpContext } from "@karowanorg/orc-ops";

const fakeHarness: Harness = {
  name: "fake",
  async discover(): Promise<HarnessCapabilities> {
    return {
      available: true,
      version: "0.0.0-fake",
      models: [{ id: "m", reasoningEfforts: [], default: true }],
      approvalModes: ["auto"],
      structuredOutput: true,
      sessions: false,
    };
  },
  // eslint-disable-next-line require-yield
  async *invoke(): AsyncIterable<never> {
    throw new Error("validate never invokes leaves");
  },
};

const registry: Registry = {
  harnesses: new Map<string, Harness>([[fakeHarness.name, fakeHarness]]),
  extensions: new Map(),
  defaultHarness: "fake",
  executor: new LocalExecutor(),
};
const ctx: OpContext = { registry };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-valhints-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function hintsFor(body: string): Promise<{ hints: string[]; ok: boolean; problems: string[] }> {
  const p = path.join(dir, "p.orc.ts");
  fs.writeFileSync(p, `export default async ({ agent, parallel, phase }: any) => ${body};\n`);
  return validate.handler(
    { programPath: p, allowWrites: false, networkAccess: false, approvalMode: "auto", checkCapabilities: false },
    ctx,
  );
}

describe("validate structure hints", () => {
  it("flags a first frontier that is a single parallel() group, without failing validation", async () => {
    const res = await hintsFor(`parallel([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }])`);
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.hints).toHaveLength(1);
    expect(res.hints[0]).toContain("one parallel() group of 3 lanes");
    expect(res.hints[0]).toContain("barrier");
  });

  it("flags the same shape wrapped in phase()", async () => {
    const res = await hintsFor(`phase("seats", () => parallel([{ prompt: "a" }, { prompt: "b" }]))`);
    expect(res.hints).toHaveLength(1);
  });

  it("stays quiet for per-lane Promise.all fan-outs", async () => {
    const res = await hintsFor(`Promise.all([agent("a"), agent("b")])`);
    expect(res.hints).toEqual([]);
  });

  it("stays quiet for a single call or a mixed frontier", async () => {
    expect((await hintsFor(`agent("solo")`)).hints).toEqual([]);
    expect((await hintsFor(`Promise.all([agent("solo"), parallel([{ prompt: "a" }, { prompt: "b" }])])`)).hints).toEqual([]);
  });
});
