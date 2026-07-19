/**
 * Cost estimation for harnesses that report tokens but not dollars.
 *
 * Claude's Agent SDK returns an exact `total_cost_usd`; codex's app-server
 * reports only token counts. For codex, orc estimates cost from a per-model
 * rate table (USD per 1M tokens). Rates are ESTIMATES — the number is marked
 * `estimated: true` so the UI can render it as "~$… est" rather than implying a
 * billed figure. Override via config (`costRates`) or `ORC_COST_RATES` (JSON).
 *
 * If a model has no rate, cost is omitted (never fabricated as zero).
 */
export interface ModelRate {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
  /** USD per 1M cached input tokens (defaults to inputPer1M when absent). */
  cachedInputPer1M?: number;
}

export interface TokenBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/**
 * Default list-price ESTIMATES for the gpt-5.x families, keyed by longest
 * matching prefix. These are editable placeholders — real billing depends on
 * your account/agreement. Override with config `costRates` or ORC_COST_RATES.
 */
export const DEFAULT_COST_RATES: Record<string, ModelRate> = {
  "gpt-5.6": { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  "gpt-5.5": { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  "gpt-5.3": { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
};

export function loadCostRates(override?: Record<string, ModelRate>): Record<string, ModelRate> {
  let fromEnv: Record<string, ModelRate> = {};
  if (process.env.ORC_COST_RATES) {
    try {
      fromEnv = JSON.parse(process.env.ORC_COST_RATES) as Record<string, ModelRate>;
    } catch {
      /* ignore malformed env */
    }
  }
  return { ...DEFAULT_COST_RATES, ...fromEnv, ...(override ?? {}) };
}

/** Longest-prefix match so "gpt-5.6-sol" resolves to the "gpt-5.6" rate. */
export function rateForModel(rates: Record<string, ModelRate>, model: string | undefined): ModelRate | undefined {
  if (!model) return undefined;
  if (rates[model]) return rates[model];
  let best: ModelRate | undefined;
  let bestLen = -1;
  for (const [key, rate] of Object.entries(rates)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = rate;
      bestLen = key.length;
    }
  }
  return best;
}

export function estimateCostUsd(
  rates: Record<string, ModelRate>,
  model: string | undefined,
  tokens: TokenBreakdown,
): number | undefined {
  const rate = rateForModel(rates, model);
  if (!rate) return undefined;
  const cached = tokens.cachedInputTokens ?? 0;
  const freshInput = Math.max((tokens.inputTokens ?? 0) - cached, 0);
  const cachedRate = rate.cachedInputPer1M ?? rate.inputPer1M;
  const cost =
    (freshInput / 1_000_000) * rate.inputPer1M +
    (cached / 1_000_000) * cachedRate +
    ((tokens.outputTokens ?? 0) / 1_000_000) * rate.outputPer1M;
  return cost;
}
