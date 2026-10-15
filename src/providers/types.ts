import type { ModelPrice } from './pricing.js';

/**
 * The provider abstraction.
 *
 * Everything above this file is provider-agnostic. Adding a third provider
 * means implementing `Provider` and registering a `ProviderFactory` — no
 * command, plugin or renderer changes.
 */

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** A JSON Schema the provider should constrain its response to. */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  system?: string;
  messages: Message[];
  maxTokens?: number;
  /**
   * Ask for schema-constrained JSON. Providers that cannot honour it must
   * throw `UnsupportedStructuredOutput` so the caller can fall back to
   * extracting JSON from free text rather than silently returning prose.
   */
  jsonSchema?: JsonSchemaSpec;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** The model that actually served the request, as reported by the API. */
  model: string;
  stopReason?: string;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; result: CompletionResult };

export interface Provider {
  /** Stable identifier used by `--provider`. */
  readonly id: string;
  readonly model: string;
  /**
   * Optional price for this provider's models, in USD per 1M tokens. When set,
   * it is used instead of the built-in table (a `pricing` entry in the config
   * still wins). Self-hosted providers use it to report a real zero rather
   * than an unknown cost.
   */
  readonly price?: ModelPrice;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
}

export interface ProviderCreateOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
  /** Wall-clock timeout for a single request, in milliseconds. */
  timeoutMs?: number;
  /** This provider's slice of `providerConfig` in the config file, keyed by provider id. */
  settings?: Record<string, unknown>;
}

export interface ProviderFactory {
  readonly id: string;
  readonly defaultModel: string;
  /** Environment variable consulted when no explicit key is configured. */
  readonly apiKeyEnvVar: string;
  create(options: ProviderCreateOptions): Provider;
}

/**
 * Thrown by a provider that cannot satisfy `jsonSchema` for the selected
 * model. Callers are expected to retry without the schema and parse the text.
 */
export class UnsupportedStructuredOutput extends Error {
  constructor(providerId: string, model: string) {
    super(`Provider "${providerId}" cannot constrain output to a JSON schema for model "${model}"`);
    this.name = 'UnsupportedStructuredOutput';
  }
}

/** Collapses a stream into a single result — the shared path for non-streaming callers. */
export async function drainStream(
  stream: AsyncIterable<StreamChunk>,
  onText?: (text: string) => void,
): Promise<CompletionResult> {
  let last: CompletionResult | undefined;
  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      onText?.(chunk.text);
    } else {
      last = chunk.result;
    }
  }
  if (!last) {
    throw new Error('Provider stream ended without emitting a final result');
  }
  return last;
}
