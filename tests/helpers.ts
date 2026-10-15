import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StreamChunk,
} from '../src/providers/types.js';
import type { ResolvedConfig } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/types.js';

export interface FakeProvider extends Provider {
  readonly calls: CompletionRequest[];
}

export interface FakeProviderOptions {
  /** Responses returned in order; the last one repeats once exhausted. */
  responses?: string[];
  respond?: (request: CompletionRequest, index: number) => string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Thrown on every call. */
  fail?: Error;
  /** Number of text chunks a streamed response is split into. */
  chunks?: number;
}

export function makeFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const calls: CompletionRequest[] = [];
  const model = options.model ?? 'gpt-4o';
  const usage = options.usage ?? { inputTokens: 100, outputTokens: 50 };

  const textFor = (request: CompletionRequest): string => {
    const index = calls.length - 1;
    if (options.respond) return options.respond(request, index);
    const responses = options.responses ?? [''];
    return responses[Math.min(index, responses.length - 1)] ?? '';
  };

  const build = (request: CompletionRequest): CompletionResult => ({
    text: textFor(request),
    model,
    usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: 'end_turn',
  });

  return {
    id: 'fake',
    model,
    calls,
    async complete(request) {
      calls.push(request);
      if (options.fail) throw options.fail;
      return build(request);
    },
    async *stream(request): AsyncIterable<StreamChunk> {
      calls.push(request);
      if (options.fail) throw options.fail;
      const result = build(request);
      const parts = splitInto(result.text, options.chunks ?? 3);
      for (const part of parts) {
        if (part) yield { type: 'text', text: part };
      }
      yield { type: 'done', result };
    },
  };
}

function splitInto(text: string, count: number): string[] {
  if (text === '' || count <= 1) return [text];
  const size = Math.ceil(text.length / count);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    cwd: process.cwd(),
    logLevel: 'silent',
    stream: false,
    ...overrides,
    review: { ...DEFAULT_CONFIG.review, ...(overrides.review ?? {}) },
    budget: { ...DEFAULT_CONFIG.budget, ...(overrides.budget ?? {}) },
    pricing: { ...DEFAULT_CONFIG.pricing, ...(overrides.pricing ?? {}) },
    pluginConfig: { ...DEFAULT_CONFIG.pluginConfig, ...(overrides.pluginConfig ?? {}) },
    providerConfig: { ...DEFAULT_CONFIG.providerConfig, ...(overrides.providerConfig ?? {}) },
  };
}

export interface TempDir {
  path: string;
  file(relative: string, contents: string): string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'swai-test-'): TempDir {
  // Canonicalised: macOS hands back /var, which is a symlink to /private/var,
  // and Windows CI hands back an 8.3 short name like C:\Users\RUNNER~1. Tests
  // that compare paths, or turn one into a URL, break on both.
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  return {
    path,
    file(relative, contents) {
      const full = join(path, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
      return full;
    },
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Collects renderer/logger output for assertions. */
export function makeSink(): { write: (chunk: string) => void; text: () => string; lines: () => string[] } {
  const parts: string[] = [];
  return {
    write: (chunk: string) => void parts.push(chunk),
    text: () => parts.join(''),
    lines: () => parts.join('').split('\n'),
  };
}
