import { describe, expect, it } from "vitest";
import { DEFAULT_COST_RATES, estimateCostUsd, loadCostRates, rateForModel } from "../src/cost.js";

describe("cost estimation", () => {
  it("matches a model to its rate by longest prefix", () => {
    const rates = loadCostRates();
    expect(rateForModel(rates, "gpt-5.6-sol")).toBe(DEFAULT_COST_RATES["gpt-5.6"]);
    expect(rateForModel(rates, "gpt-5.6")).toBe(DEFAULT_COST_RATES["gpt-5.6"]);
    expect(rateForModel(rates, "gpt-5.3-codex-spark")).toBe(DEFAULT_COST_RATES["gpt-5.3"]);
  });

  it("returns undefined (never fabricates) for an unknown model", () => {
    const rates = loadCostRates();
    expect(rateForModel(rates, "some-unknown-model")).toBeUndefined();
    expect(estimateCostUsd(rates, "some-unknown-model", { inputTokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd(rates, undefined, { inputTokens: 1000 })).toBeUndefined();
  });

  it("computes cost from the breakdown, pricing cached input separately", () => {
    const rates = { m: { inputPer1M: 2, outputPer1M: 10, cachedInputPer1M: 0.2 } };
    // 1M fresh input @ $2 + 1M cached @ $0.2 + 0.5M output @ $10
    const cost = estimateCostUsd(rates, "m", {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(2 + 0.2 + 5, 6);
  });

  it("falls back to input rate when no cached rate is set", () => {
    const rates = { m: { inputPer1M: 3, outputPer1M: 0 } };
    const cost = estimateCostUsd(rates, "m", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 });
    // cached is a subset of input; fresh = 0, cached 1M @ input rate 3
    expect(cost).toBeCloseTo(3, 6);
  });

  it("honors config override and ORC_COST_RATES env", () => {
    const override = loadCostRates({ "gpt-5.6": { inputPer1M: 99, outputPer1M: 99 } });
    expect(override["gpt-5.6"].inputPer1M).toBe(99);
    process.env.ORC_COST_RATES = JSON.stringify({ custom: { inputPer1M: 1, outputPer1M: 1 } });
    try {
      expect(rateForModel(loadCostRates(), "custom-x")).toEqual({ inputPer1M: 1, outputPer1M: 1 });
    } finally {
      delete process.env.ORC_COST_RATES;
    }
  });
});
