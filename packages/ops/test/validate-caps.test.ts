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
  ExtensionLeaf,
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

  it("reports capability discovery failures instead of silently skipping them", async () => {
    const broken: Harness = {
      ...fakeHarness,
      name: "broken",
      async discover() {
        throw new Error("probe exploded");
      },
    };
    const res = await validate.handler(
      {
        programPath: programFor(`{ harness: "broken" }`),
        allowWrites: false,
        checkCapabilities: true,
      },
      {
        registry: {
          ...registry,
          harnesses: new Map([[broken.name, broken]]),
          defaultHarness: broken.name,
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain('could not discover harness "broken"');
    expect(res.problems.join("\n")).toContain("probe exploded");
  });

  it("rejects schemas when live capabilities lack structured output", async () => {
    const plain: Harness = {
      ...fakeHarness,
      name: "plain",
      async discover() {
        return { ...(await fakeHarness.discover({ executor: executorFor(undefined) })), structuredOutput: false };
      },
    };
    const res = await validate.handler(
      {
        programPath: programFor(`{ harness: "plain", schema: { type: "string" } }`),
        allowWrites: false,
        checkCapabilities: true,
      },
      {
        registry: {
          ...registry,
          harnesses: new Map([[plain.name, plain]]),
          defaultHarness: plain.name,
        },
      },
    );
    expect(res.problems.join("\n")).toContain('harness "plain" does not support structured output');
  });

  it("probes the per-call host rather than the validate-wide host", async () => {
    const hosts: Array<string | undefined> = [];
    const res = await validate.handler(
      {
        programPath: programFor(`{ harness: "fake", host: "leaf@box" }`),
        allowWrites: false,
        host: "default@box",
        checkCapabilities: true,
      },
      {
        registry: {
          ...registry,
          executorFor(host) {
            hosts.push(host);
            return executorFor(undefined);
          },
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(hosts).toEqual(["leaf@box"]);
    expect(res.firstCalls[0]?.host).toBe("leaf@box");
  });

  it("uses launch-equivalent default harness and approval mode", async () => {
    const manualOnly: Harness = {
      ...fakeHarness,
      name: "manual-only",
      async discover() {
        return {
          ...(await fakeHarness.discover({ executor: executorFor(undefined) })),
          approvalModes: ["manual"],
        };
      },
    };
    const res = await validate.handler(
      {
        programPath: programFor(`{}`),
        allowWrites: false,
        harness: manualOnly.name,
        checkCapabilities: true,
      },
      {
        registry: {
          ...registry,
          harnesses: new Map([
            [fakeHarness.name, fakeHarness],
            [manualOnly.name, manualOnly],
          ]),
        },
      },
    );
    expect(res.problems.join("\n")).toContain('harness "manual-only" cannot honor approval mode "auto"');
  });

  it("uses registered extension readOnly metadata for the write gate", async () => {
    const extension: ExtensionLeaf = {
      name: "writer",
      readOnly: false,
      async execute() {
        return null;
      },
    };
    const program = path.join(dir, "extension.orc.ts");
    fs.writeFileSync(program, `export default async ({ ext }: any) => ext.writer({ value: 1 });\n`);
    const res = await validate.handler(
      { programPath: program, allowWrites: false, checkCapabilities: false },
      {
        registry: {
          ...registry,
          extensions: new Map([[extension.name, extension]]),
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.firstCalls[0]?.readOnly).toBe(false);
    expect(res.problems.join("\n")).toContain("allowWrites was not granted");
  });
});
