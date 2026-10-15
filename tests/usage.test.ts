import { describe, expect, it } from 'vitest';

import { computeCost, DEFAULT_PRICING, formatUsd, priceFor } from '../src/providers/pricing.js';
import { UsageTracker, formatUsageSummary } from '../src/kernel/usage.js';
import { BudgetExceededError } from '../src/kernel/errors.js';

const result = (model: string, inputTokens: number, outputTokens: number) => ({
  model,
  usage: { inputTokens, outputTokens },
});

describe('priceFor', () => {
  it('matches an exact model id', () => {
    expect(priceFor('gpt-4o')).toEqual(DEFAULT_PRICING['gpt-4o']);
  });

  it('falls back to the longest matching key for dated or prefixed ids', () => {
    // `gpt-4o` is also a substring here; the longer key must win.
    expect(priceFor('gpt-4o-mini-2024-07-18')).toEqual(DEFAULT_PRICING['gpt-4o-mini']);
    expect(priceFor('openai/gpt-4o')).toEqual(DEFAULT_PRICING['gpt-4o']);
  });

  it('returns undefined for an unknown model', () => {
    expect(priceFor('some-unreleased-model')).toBeUndefined();
  });
});

describe('computeCost', () => {
  it('prices input and output separately', () => {
    // 1M input at $2.50 + 1M output at $10.
    const { costUsd, unpriced } = computeCost('gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(unpriced).toBe(false);
    expect(costUsd).toBeCloseTo(12.5, 6);
  });

  it('prices cache reads and writes at their own rates', () => {
    const { costUsd } = computeCost(
      'm',
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      { m: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
    );
    expect(costUsd).toBeCloseTo(0.5 + 6.25, 6);
  });

  it('prices cache tokens at the input rate when no cache rate is listed', () => {
    const { costUsd } = computeCost(
      'm',
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      { m: { input: 2, output: 8 } },
    );
    expect(costUsd).toBeCloseTo(4, 6);
  });

  it('reports an unknown model as unpriced rather than free', () => {
    const { costUsd, unpriced } = computeCost('mystery-model', {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(unpriced).toBe(true);
    expect(costUsd).toBeNull();
  });

  it('honours a pricing override', () => {
    const { costUsd } = computeCost(
      'mystery-model',
      { inputTokens: 1_000_000, outputTokens: 0 },
      { ...DEFAULT_PRICING, 'mystery-model': { input: 42, output: 99 } },
    );
    expect(costUsd).toBeCloseTo(42, 6);
  });
});

describe('formatUsd', () => {
  it('renders unknown, zero, sub-cent and normal amounts distinctly', () => {
    expect(formatUsd(null)).toBe('unknown');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(0.000123)).toBe('$0.000123');
    expect(formatUsd(1.5)).toBe('$1.5000');
  });
});

describe('UsageTracker', () => {
  it('accumulates tokens and cost across calls', () => {
    const tracker = new UsageTracker();
    tracker.record({ provider: 'openai', command: 'review', result: result('gpt-4o', 1000, 500) });
    tracker.record({ provider: 'openai', command: 'review', result: result('gpt-4o', 2000, 100) });

    const summary = tracker.summary();
    expect(summary.calls).toBe(2);
    expect(summary.inputTokens).toBe(3000);
    expect(summary.outputTokens).toBe(600);
    expect(summary.totalTokens).toBe(3600);
    expect(summary.costUsd).toBeCloseTo((3000 / 1e6) * 2.5 + (600 / 1e6) * 10, 9);
  });

  it('reports total cost as unknown if any call used an unpriced model', () => {
    const tracker = new UsageTracker();
    tracker.record({ provider: 'x', command: 'c', result: result('gpt-4o', 100, 100) });
    tracker.record({ provider: 'x', command: 'c', result: result('mystery', 100, 100) });

    const summary = tracker.summary();
    expect(summary.costUsd).toBeNull();
    expect(summary.unpricedModels).toEqual(['mystery']);
  });

  it('prices a provider that declares its own price at that price, not the built-in table', () => {
    const tracker = new UsageTracker();
    // A self-hosted model that happens to share a name with a hosted one.
    const local = tracker.record({
      provider: 'compat',
      command: 'c',
      result: result('gpt-4o', 1_000_000, 1_000_000),
      price: { input: 0, output: 0 },
    });
    expect(local).toMatchObject({ costUsd: 0, unpriced: false });

    const unknown = tracker.record({
      provider: 'compat',
      command: 'c',
      result: result('llama3.1:8b', 1_000_000, 1_000_000),
      price: { input: 0.1, output: 0.2 },
    });
    expect(unknown.costUsd).toBeCloseTo(0.3, 9);
    expect(tracker.summary().unpricedModels).toEqual([]);
  });

  it('lets a pricing override beat the provider price', () => {
    const tracker = new UsageTracker({ pricing: { 'llama3.1:8b': { input: 1, output: 1 } } });
    const record = tracker.record({
      provider: 'compat',
      command: 'c',
      result: result('llama3.1:8b', 1_000_000, 0),
      price: { input: 0, output: 0 },
    });
    expect(record.costUsd).toBeCloseTo(1, 9);
  });

  it('throws once the token budget is crossed', () => {
    const tracker = new UsageTracker({ budget: { maxTokens: 1000 } });
    expect(() =>
      tracker.record({ provider: 'x', command: 'c', result: result('gpt-4o', 900, 200) }),
    ).toThrow(BudgetExceededError);
  });

  it('throws once the cost budget is crossed', () => {
    const tracker = new UsageTracker({ budget: { maxUsd: 0.001 } });
    expect(() =>
      tracker.record({
        provider: 'x',
        command: 'c',
        result: result('gpt-4o', 1_000_000, 0),
      }),
    ).toThrow(/Cost budget exceeded/);
  });

  it('stays under budget for calls that fit', () => {
    const tracker = new UsageTracker({ budget: { maxTokens: 10_000, maxUsd: 10 } });
    expect(() =>
      tracker.record({ provider: 'x', command: 'c', result: result('gpt-4o', 100, 100) }),
    ).not.toThrow();
  });
});

describe('formatUsageSummary', () => {
  it('reports nothing when no calls were made', () => {
    expect(formatUsageSummary(new UsageTracker().summary())).toBe('No model calls.');
  });

  it('summarises calls, tokens and cost', () => {
    const tracker = new UsageTracker();
    tracker.record({ provider: 'x', command: 'c', result: result('gpt-4o', 1000, 500) });
    const line = formatUsageSummary(tracker.summary());
    expect(line).toContain('1 call');
    expect(line).toContain('1,000 in');
    expect(line).toContain('500 out');
    expect(line).toContain('$');
  });

  it('flags unpriced models so a zero is never mistaken for free', () => {
    const tracker = new UsageTracker();
    tracker.record({ provider: 'x', command: 'c', result: result('mystery', 10, 10) });
    expect(formatUsageSummary(tracker.summary())).toContain('no price for mystery');
  });
});
