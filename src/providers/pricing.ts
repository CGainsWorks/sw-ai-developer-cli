/**
 * Token pricing, in US dollars per million tokens.
 *
 * These are list prices at the time of writing and they change. They are the
 * *default* table only: `pricing` in the config file overrides any entry, and
 * `swai price --list` prints exactly what is in effect. A model with no entry
 * is reported as `costUsd: null` rather than being silently priced at zero —
 * an unknown cost must never look like a free one.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M tokens read from cache, when the provider bills it separately. */
  cacheRead?: number;
  /** USD per 1M tokens written to cache. */
  cacheWrite?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * List prices for the hosted OpenAI API. The `compat` provider does not use
 * this table: it prices from `providerConfig.compat.price` (zero by default)
 * unless your own `pricing` has an entry for the model.
 */
export const DEFAULT_PRICING: PriceTable = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
};

export interface CostBreakdown {
  /** Null when the model is not in the price table. */
  costUsd: number | null;
  /** True when no price was found, so callers can warn rather than trust a 0. */
  unpriced: boolean;
}

export function priceFor(model: string, table: PriceTable = DEFAULT_PRICING): ModelPrice | undefined {
  const exact = table[model];
  if (exact) return exact;

  // Tolerate dated snapshots (`gpt-4o-mini-2024-07-18`) and provider
  // prefixes (`openai/gpt-4o`) by falling back to the longest table key the
  // model id contains.
  let best: ModelPrice | undefined;
  let bestLength = 0;
  for (const [key, value] of Object.entries(table)) {
    if (model.includes(key) && key.length > bestLength) {
      best = value;
      bestLength = key.length;
    }
  }
  return best;
}

export function computeCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  table: PriceTable = DEFAULT_PRICING,
): CostBreakdown {
  return costFor(priceFor(model, table), usage);
}

/** Prices `usage` at `price`, or reports it as unpriced when there is none. */
export function costFor(
  price: ModelPrice | undefined,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): CostBreakdown {
  if (!price) return { costUsd: null, unpriced: true };

  const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

  const cost =
    perMillion(usage.inputTokens, price.input) +
    perMillion(usage.outputTokens, price.output) +
    perMillion(usage.cacheReadTokens ?? 0, price.cacheRead ?? price.input) +
    perMillion(usage.cacheWriteTokens ?? 0, price.cacheWrite ?? price.input);

  return { costUsd: cost, unpriced: false };
}

export function formatUsd(value: number | null): string {
  if (value === null) return 'unknown';
  if (value === 0) return '$0.0000';
  // Sub-cent costs are the common case; four decimals keeps them legible.
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}
