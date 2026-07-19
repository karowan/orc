/**
 * The guide bakes step-2 (capability discovery) into its own response: one
 * `guide` call returns the static doc PLUS this machine's live harness/model
 * catalog, so a model can go straight to writing with valid values in hand.
 * `probe: false` opts back out to the pure doc.
 */
import { describe, expect, it } from "vitest";
import type {
  Executor,
  Harness,
  HarnessCapabilities,
  Registry,
} from "@orc/core";
import { executorFor } from "@orc/executors";
import { guide, GUIDE, type OpContext } from "@orc/ops";

const fakeHarness: Harness = {
  name: "fake",
  async discover(): Promise<HarnessCapabilities> {
    return {
      available: true,
      version: "9.9.9",
      models: [
        { id: "m-full", reasoningEfforts: ["low", "high"], default: true },
        { id: "m-none", reasoningEfforts: [] },
      ],
      approvalModes: ["manual", "auto"],
      structuredOutput: true,
      sessions: false,
    };
  },
  // eslint-disable-next-line require-yield
  async *invoke(): AsyncIterable<never> {
    throw new Error("guide never invokes leaves");
  },
};

const registry: Registry = {
  harnesses: new Map<string, Harness>([[fakeHarness.name, fakeHarness]]),
  extensions: new Map(),
  defaultHarness: "fake",
  executorFor: (host?: string): Executor => executorFor(host),
};
const ctx: OpContext = { registry };

describe("guide (baked-in capabilities)", () => {
  it("appends the live catalog with per-model reasoning ladders", async () => {
    const { guide: text } = await guide.handler({ probe: true }, ctx);
    expect(text.startsWith(GUIDE)).toBe(true);
    expect(text).toContain("## Available on this machine");
    expect(text).toContain("Default harness: **fake**");
    expect(text).toContain("`m-full` (default) — reasoningEffort: low, high");
    // The whole point: a model that takes no effort param says so explicitly.
    expect(text).toContain("`m-none` — no reasoningEffort");
  });

  it("returns the pure doc when probing is disabled", async () => {
    const { guide: text } = await guide.handler({ probe: false }, ctx);
    expect(text).toBe(GUIDE);
    expect(text).not.toContain("## Available on this machine");
  });

  it("degrades to the static doc when a harness probe throws", async () => {
    const boom: Harness = {
      name: "boom",
      async discover(): Promise<HarnessCapabilities> {
        throw new Error("kaboom");
      },
      // eslint-disable-next-line require-yield
      async *invoke(): AsyncIterable<never> {
        throw new Error("unused");
      },
    };
    const r: Registry = { ...registry, harnesses: new Map([[boom.name, boom]]), defaultHarness: "boom" };
    const { guide: text } = await guide.handler({ probe: true }, { registry: r });
    // capabilities catches per-harness errors, so the section still renders,
    // marking the harness unavailable rather than failing the guide.
    expect(text.startsWith(GUIDE)).toBe(true);
    expect(text).toContain("**boom** — unavailable");
  });
});
