/**
 * Per-model capability validation: reasoning efforts are attached to each
 * model, so `validate --check-capabilities` must gate an effort against the
 * SPECIFIC model's ladder — including the "no effort param at all" case
 * (e.g. Haiku vs. Fable), where an empty ladder rejects any effort.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Executor,
  Harness,
  HarnessCapabilities,
  Registry,
} from "@orc/core";
import { executorFor } from "@orc/executors";
import { validate, type OpContext } from "@orc/ops";

// A harness whose catalog carries one model with a ladder and one that takes
// no effort param — the shape the real claude/codex harnesses now report.
const fakeHarness: Harness = {
  name: "fake",
  async discover(): Promise<HarnessCapabilities> {
    return {
      available: true,
      version: "0.0.0-fake",
      models: [
        { id: "m-full", reasoningEfforts: ["low", "high"], default: true },
        { id: "m-none", reasoningEfforts: [] },
      ],
      approvalModes: ["manual", "accept-edits", "auto", "bypass"],
      structuredOutput: true,
      sessions: false,
    };
  },
  // eslint-disable-next-line require-yield
  async *invoke(): AsyncIterable<never> {
    throw new Error("validate never invokes leaves");
  },
  // Strict harness: reject open-ended objects in output schemas.
  lintOutputSchema(schema): string[] {
    const s = schema as { properties?: Record<string, { additionalProperties?: unknown }> };
    const open = Object.entries(s.properties ?? {}).filter(([, v]) => v.additionalProperties === true);
    return open.map(([k]) => `$.properties.${k}: open-ended object`);
  },
};

const registry: Registry = {
  harnesses: new Map<string, Harness>([[fakeHarness.name, fakeHarness]]),
  extensions: new Map(),
  defaultHarness: "fake",
  executorFor: (host?: string): Executor => executorFor(host),
};
const ctx: OpContext = { registry };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-valcaps-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function programFor(opts: string): string {
  const p = path.join(dir, "p.orc.ts");
  fs.writeFileSync(p, `export default async ({ agent }: any) => agent("hi", ${opts});\n`);
  return p;
}

describe("validate --check-capabilities (per-model reasoning efforts)", () => {
  it("accepts an effort the model actually supports", async () => {
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", model: "m-full", reasoningEffort: "high" }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("rejects an effort outside the model's ladder", async () => {
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", model: "m-full", reasoningEffort: "xhigh" }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain(`reasoning effort "xhigh" not supported by model "m-full"`);
  });

  it("rejects ANY effort on a model that takes no effort param", async () => {
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", model: "m-none", reasoningEffort: "high" }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain(`model "m-none" takes no reasoning effort`);
  });

  it("rejects an unknown model against the catalog", async () => {
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", model: "m-ghost" }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain(`model "m-ghost" not in fake's catalog`);
  });

  it("gates an effort against the catalog union when no model is pinned", async () => {
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", reasoningEffort: "ultra" }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain(`reasoning effort "ultra" not supported by fake`);
  });

  it("rejects an output schema the harness would fail on at runtime", async () => {
    const schema = `{ type: "object", properties: { metrics: { type: "object", additionalProperties: true } } }`;
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", schema: ${schema} }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("output schema $.properties.metrics: open-ended object");
  });

  it("runs the schema lint even with capability probing disabled", async () => {
    const schema = `{ type: "object", properties: { metrics: { type: "object", additionalProperties: true } } }`;
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", schema: ${schema} }`), allowWrites: false, checkCapabilities: false },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("output schema");
  });

  it("accepts a strict output schema", async () => {
    const schema = `{ type: "object", additionalProperties: false, properties: { n: { type: "number" } }, required: ["n"] }`;
    const res = await validate.handler(
      { programPath: programFor(`{ harness: "fake", schema: ${schema} }`), allowWrites: false, checkCapabilities: true },
      ctx,
    );
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });
});
