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
export interface TokenRate {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
  /** USD per 1M cached input tokens (defaults to inputPer1M when absent). */
  cachedInputPer1M?: number;
  /** USD per 1M cache-write input tokens (defaults to inputPer1M when absent). */
  cacheWriteInputPer1M?: number;
}

export interface ModelRate extends TokenRate {
  /** Alternate direct-API rates above an input-token threshold. */
  longContext?: TokenRate & { aboveInputTokens: number };
  /** Direct Fast/Priority multiplier. Absent means the tier is unsupported. */
  fastMultiplier?: number;
  /** Provider input limit. Usage above it cannot be priced by this profile. */
  maxInputTokens?: number;
}

export interface TokenBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

/**
 * GPT-5.6 Standard list-price estimates. Keys are exact model IDs because the
 * Sol, Terra, Luna, direct, and Bedrock prices are materially different.
 */
export const DEFAULT_COST_RATES: Record<string, ModelRate> = {
  "gpt-5.6-sol": {
    inputPer1M: 5,
    cachedInputPer1M: 0.5,
    cacheWriteInputPer1M: 6.25,
    outputPer1M: 30,
    longContext: {
      aboveInputTokens: 272_000,
      inputPer1M: 10,
      cachedInputPer1M: 1,
      cacheWriteInputPer1M: 12.5,
      outputPer1M: 45,
    },
    fastMultiplier: 2,
  },
  "gpt-5.6-terra": {
    inputPer1M: 2,
    cachedInputPer1M: 0.2,
    cacheWriteInputPer1M: 2.5,
    outputPer1M: 12,
    longContext: {
      aboveInputTokens: 272_000,
      inputPer1M: 4,
      cachedInputPer1M: 0.4,
      cacheWriteInputPer1M: 5,
      outputPer1M: 18,
    },
    fastMultiplier: 2,
  },
  "gpt-5.6-luna": {
    inputPer1M: 0.2,
    cachedInputPer1M: 0.02,
    cacheWriteInputPer1M: 0.25,
    outputPer1M: 1.2,
    longContext: {
      aboveInputTokens: 272_000,
      inputPer1M: 0.4,
      cachedInputPer1M: 0.04,
      cacheWriteInputPer1M: 0.5,
      outputPer1M: 1.8,
    },
    fastMultiplier: 2,
  },
  "openai.gpt-5.6-sol": {
    inputPer1M: 5.5,
    cachedInputPer1M: 0.55,
    cacheWriteInputPer1M: 6.875,
    outputPer1M: 33,
    maxInputTokens: 272_000,
  },
  "openai.gpt-5.6-terra": {
    inputPer1M: 2.2,
    cachedInputPer1M: 0.22,
    cacheWriteInputPer1M: 2.75,
    outputPer1M: 13.2,
    maxInputTokens: 272_000,
  },
  "openai.gpt-5.6-luna": {
    inputPer1M: 0.22,
    cachedInputPer1M: 0.022,
    cacheWriteInputPer1M: 0.275,
    outputPer1M: 1.32,
    maxInputTokens: 272_000,
  },
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

export function rateForModel(rates: Record<string, ModelRate>, model: string | undefined): ModelRate | undefined {
  if (!model) return undefined;
  return rates[model];
}

export function estimateCostUsd(
  rates: Record<string, ModelRate>,
  model: string | undefined,
  tokens: TokenBreakdown,
  serviceTier?: string | null,
): number | undefined {
  const rate = rateForModel(rates, model);
  if (!rate) return undefined;

  let multiplier = 1;
  switch (serviceTier) {
    case undefined:
    case null:
    case "default":
    case "standard":
      break;
    case "fast":
    case "priority":
      if (rate.fastMultiplier === undefined) return undefined;
      multiplier = rate.fastMultiplier;
      break;
    default:
      return undefined;
  }

  const input = tokens.inputTokens ?? 0;
  if (rate.maxInputTokens !== undefined && input > rate.maxInputTokens) return undefined;

  let tokenRate: TokenRate = rate;
  if (rate.longContext && input > rate.longContext.aboveInputTokens) {
    // Direct Fast/Priority does not support the long-context schedule.
    if (multiplier !== 1) return undefined;
    tokenRate = rate.longContext;
  }

  const cached = tokens.cachedInputTokens ?? 0;
  const cacheWrite = tokens.cacheWriteInputTokens ?? 0;
  const freshInput = Math.max(input - cached - cacheWrite, 0);
  const cachedRate = tokenRate.cachedInputPer1M ?? tokenRate.inputPer1M;
  const cacheWriteRate = tokenRate.cacheWriteInputPer1M ?? tokenRate.inputPer1M;
  const cost =
    (freshInput / 1_000_000) * tokenRate.inputPer1M +
    (cached / 1_000_000) * cachedRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    ((tokens.outputTokens ?? 0) / 1_000_000) * tokenRate.outputPer1M;
  return cost * multiplier;
}
