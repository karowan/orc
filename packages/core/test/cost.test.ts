import { describe, expect, it } from "vitest";
import { DEFAULT_COST_RATES, estimateCostUsd, loadCostRates, rateForModel } from "../src/cost.js";

describe("cost estimation", () => {
  it("uses exact direct and Bedrock GPT-5.6 model IDs", () => {
    const rates = loadCostRates();
    for (const model of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "openai.gpt-5.6-sol",
      "openai.gpt-5.6-terra",
      "openai.gpt-5.6-luna",
    ]) {
      expect(rateForModel(rates, model)).toBe(DEFAULT_COST_RATES[model]);
    }
  });

  it("does not use a generic family fallback or prefix matching", () => {
    const rates = loadCostRates();
    expect(rateForModel(rates, "gpt-5.6")).toBeUndefined();
    expect(rateForModel(rates, "gpt-5.6-sol-preview")).toBeUndefined();
    expect(rateForModel(rates, "some-unknown-model")).toBeUndefined();
    expect(estimateCostUsd(rates, undefined, { inputTokens: 1000 })).toBeUndefined();
  });

  it.each([
    ["gpt-5.6-sol", 5 + 0.5 + 6.25 + 30],
    ["gpt-5.6-terra", 2 + 0.2 + 2.5 + 12],
    ["gpt-5.6-luna", 0.2 + 0.02 + 0.25 + 1.2],
    ["openai.gpt-5.6-sol", 5.5 + 0.55 + 6.875 + 33],
    ["openai.gpt-5.6-terra", 2.2 + 0.22 + 2.75 + 13.2],
    ["openai.gpt-5.6-luna", 0.22 + 0.022 + 0.275 + 1.32],
  ])("prices fresh, cached, cache-write, and output tokens for %s", (model, expected) => {
    const cost = estimateCostUsd(loadCostRates(), model, {
      inputTokens: 3,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 1,
      outputTokens: 1,
    });
    expect(cost).toBeCloseTo(expected / 1_000_000, 15);
  });

  it("falls back to the input rate for unspecified cache rates", () => {
    const rates = { m: { inputPer1M: 3, outputPer1M: 0 } };
    const cost = estimateCostUsd(rates, "m", {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 10);
  });

  it.each([
    ["gpt-5.6-sol", 10 + 1 + 12.5 + 45],
    ["gpt-5.6-terra", 4 + 0.4 + 5 + 18],
    ["gpt-5.6-luna", 0.4 + 0.04 + 0.5 + 1.8],
  ])("uses direct long-context rates for %s", (model, expected) => {
    const cost = estimateCostUsd(loadCostRates(), model, {
      inputTokens: 3_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("uses Standard rates at the direct long-context boundary", () => {
    const cost = estimateCostUsd(loadCostRates(), "gpt-5.6-sol", {
      inputTokens: 272_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.272 * 5 + 30, 10);
  });

  it("applies Fast/Priority only to supported direct requests", () => {
    const tokens = { inputTokens: 100_000, outputTokens: 10_000 };
    const standard = estimateCostUsd(loadCostRates(), "gpt-5.6-terra", tokens, "standard");
    expect(estimateCostUsd(loadCostRates(), "gpt-5.6-terra", tokens, "fast")).toBeCloseTo(standard! * 2, 10);
    expect(estimateCostUsd(loadCostRates(), "gpt-5.6-terra", tokens, "priority")).toBeCloseTo(standard! * 2, 10);
    expect(estimateCostUsd(loadCostRates(), "openai.gpt-5.6-terra", tokens, "fast")).toBeUndefined();
  });

  it("does not price unsupported Fast long-context or Bedrock over-limit usage", () => {
    const tokens = { inputTokens: 272_001 };
    expect(estimateCostUsd(loadCostRates(), "gpt-5.6-sol", tokens, "fast")).toBeUndefined();
    expect(estimateCostUsd(loadCostRates(), "openai.gpt-5.6-sol", tokens)).toBeUndefined();
  });

  it("returns undefined for an unknown service tier", () => {
    expect(
      estimateCostUsd(loadCostRates(), "gpt-5.6-sol", { inputTokens: 1000 }, "future-tier"),
    ).toBeUndefined();
  });

  it("honors exact config and ORC_COST_RATES overrides", () => {
    const override = loadCostRates({ "gpt-5.6-sol": { inputPer1M: 99, outputPer1M: 99 } });
    expect(rateForModel(override, "gpt-5.6-sol")).toEqual({ inputPer1M: 99, outputPer1M: 99 });

    process.env.ORC_COST_RATES = JSON.stringify({ custom: { inputPer1M: 1, outputPer1M: 2 } });
    try {
      const rates = loadCostRates();
      expect(rateForModel(rates, "custom")).toEqual({ inputPer1M: 1, outputPer1M: 2 });
      expect(rateForModel(rates, "custom-preview")).toBeUndefined();
    } finally {
      delete process.env.ORC_COST_RATES;
    }
  });
});
