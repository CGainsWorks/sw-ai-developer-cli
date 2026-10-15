import { BudgetExceededError } from './errors.js';
import {
  costFor,
  DEFAULT_PRICING,
  formatUsd,
  priceFor,
  type ModelPrice,
  type PriceTable,
} from '../providers/pricing.js';
import type { BudgetConfig } from '../config/types.js';
import type { CompletionResult } from '../providers/types.js';

export interface UsageRecord {
  provider: string;
  model: string;
  command: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  unpriced: boolean;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when any call used a model with no known price. */
  costUsd: number | null;
  /** Models seen that had no price entry. */
  unpricedModels: string[];
  records: UsageRecord[];
}

export interface UsageTrackerOptions {
  budget?: BudgetConfig;
  pricing?: PriceTable;
}

/**
 * Accumulates token and cost totals, and enforces the budget.
 *
 * The budget is checked *after* each call rather than predicted before it:
 * output length is not knowable in advance, so a pre-check would either be a
 * guess or reject everything. The guarantee is "stop as soon as the ceiling is
 * crossed", not "never cross it".
 */
export class UsageTracker {
  private readonly records: UsageRecord[] = [];
  private readonly budget: BudgetConfig;
  private readonly overrides: PriceTable;
  private readonly pricing: PriceTable;

  constructor(options: UsageTrackerOptions = {}) {
    this.budget = options.budget ?? {};
    this.overrides = options.pricing ?? {};
    this.pricing = { ...DEFAULT_PRICING, ...this.overrides };
  }

  record(entry: {
    provider: string;
    command: string;
    result: Pick<CompletionResult, 'model' | 'usage'>;
    /** The provider's own price for the model, from `Provider.price`. */
    price?: ModelPrice | undefined;
  }): UsageRecord {
    const { usage, model } = entry.result;
    const { costUsd, unpriced } = costFor(this.priceFor(model, entry.price), usage);

    const record: UsageRecord = {
      provider: entry.provider,
      model,
      command: entry.command,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd,
      unpriced,
    };
    this.records.push(record);
    this.enforceBudget();
    return record;
  }

  /**
   * Your `pricing` config always wins. Otherwise a provider that declares its
   * own price (the `compat` provider always does) is priced at that. It is
   * never matched against the built-in table of hosted list prices.
   */
  private priceFor(model: string, providerPrice: ModelPrice | undefined): ModelPrice | undefined {
    if (providerPrice) return priceFor(model, this.overrides) ?? providerPrice;
    return priceFor(model, this.pricing);
  }

  summary(): UsageSummary {
    const summary: UsageSummary = {
      calls: this.records.length,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpricedModels: [],
      records: [...this.records],
    };

    let anyUnpriced = false;
    for (const r of this.records) {
      summary.inputTokens += r.inputTokens;
      summary.outputTokens += r.outputTokens;
      summary.cacheReadTokens += r.cacheReadTokens;
      summary.cacheWriteTokens += r.cacheWriteTokens;
      if (r.unpriced) {
        anyUnpriced = true;
        if (!summary.unpricedModels.includes(r.model)) summary.unpricedModels.push(r.model);
      } else if (summary.costUsd !== null) {
        summary.costUsd += r.costUsd ?? 0;
      }
    }

    summary.totalTokens =
      summary.inputTokens + summary.outputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
    if (anyUnpriced) summary.costUsd = null;
    return summary;
  }

  /** Total spend so far, treating unpriced calls as zero. */
  private spendSoFar(): number {
    return this.records.reduce((total, r) => total + (r.costUsd ?? 0), 0);
  }

  private enforceBudget(): void {
    const { maxUsd, maxTokens } = this.budget;

    if (maxTokens !== undefined) {
      const used = this.summary().totalTokens;
      if (used > maxTokens) {
        throw new BudgetExceededError(
          `Token budget exceeded: used ${used.toLocaleString()} of ${maxTokens.toLocaleString()}`,
          { hint: 'Raise budget.maxTokens in your config, or narrow the input.' },
        );
      }
    }

    if (maxUsd !== undefined) {
      const spent = this.spendSoFar();
      if (spent > maxUsd) {
        throw new BudgetExceededError(
          `Cost budget exceeded: spent ${formatUsd(spent)} of ${formatUsd(maxUsd)}`,
          { hint: 'Raise budget.maxUsd in your config, or use a cheaper model.' },
        );
      }
    }
  }
}

export function formatUsageSummary(summary: UsageSummary): string {
  if (summary.calls === 0) return 'No model calls.';
  const parts = [
    `${summary.calls} call${summary.calls === 1 ? '' : 's'}`,
    `${summary.inputTokens.toLocaleString()} in`,
    `${summary.outputTokens.toLocaleString()} out`,
  ];
  if (summary.cacheReadTokens > 0) {
    parts.push(`${summary.cacheReadTokens.toLocaleString()} cache-read`);
  }
  parts.push(formatUsd(summary.costUsd));
  let line = parts.join(' · ');
  if (summary.unpricedModels.length > 0) {
    line += ` (no price for ${summary.unpricedModels.join(', ')} — set "pricing" in config)`;
  }
  return line;
}
