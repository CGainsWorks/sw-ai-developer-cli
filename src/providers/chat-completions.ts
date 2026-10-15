/**
 * The OpenAI Chat Completions wire format, shared by every provider that
 * speaks it.
 *
 * `openai` and `compat` differ only in where they connect, how they find a key
 * and how they word their errors. The request shape, streaming and token
 * accounting live here once, so the two cannot drift apart.
 */
import { ProviderError } from '../kernel/errors.js';
import {
  UnsupportedStructuredOutput,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk,
} from './types.js';

/** The subset of the SDK client these providers use, so tests can substitute it. */
export interface ChatCompletionsClientLike {
  chat: {
    completions: {
      create(
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ): Promise<unknown>;
    };
  };
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: ChatUsage | null;
}

interface ChatChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: ChatUsage | null;
}

export interface ChatCompletionsDialect {
  /**
   * Which field carries the output ceiling. OpenAI's newer reasoning models
   * reject `max_tokens`; most self-hosted servers only understand it.
   */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /**
   * Treat any HTTP 400 or 422 on a schema-constrained request as "schema not
   * supported". Self-hosted servers word that error in many different ways,
   * and retrying unconstrained is cheaper than failing the command.
   */
  lenientSchemaErrors: boolean;
}

/** How a subclass describes a failure, so the messages name the right service. */
export interface FailureContext {
  status: number | undefined;
  message: string;
  err: unknown;
}

export abstract class ChatCompletionsProvider implements Provider {
  abstract readonly id: string;
  readonly model: string;

  protected readonly client: ChatCompletionsClientLike;
  private readonly maxTokens: number;
  private readonly dialect: ChatCompletionsDialect;

  protected constructor(init: {
    model: string;
    maxTokens: number;
    client: ChatCompletionsClientLike;
    dialect: ChatCompletionsDialect;
  }) {
    this.model = init.model;
    this.maxTokens = init.maxTokens;
    this.client = init.client;
    this.dialect = init.dialect;
  }

  /** Maps a failed request to a ProviderError worded for this service. */
  protected abstract describeFailure(failure: FailureContext): ProviderError;

  private buildParams(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) messages.push({ role: m.role, content: m.content });

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      [this.dialect.maxTokensField]: request.maxTokens ?? this.maxTokens,
    };

    if (request.jsonSchema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: true,
        },
      };
    }

    if (stream) {
      params.stream = true;
      // Without this the final chunk carries no usage and cost accounting
      // silently reports zero.
      params.stream_options = { include_usage: true };
    }

    return params;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params = this.buildParams(request, false);
    let completion: ChatCompletion;
    try {
      completion = (await this.client.chat.completions.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      )) as ChatCompletion;
    } catch (err) {
      throw this.wrap(err, request);
    }

    const choice = completion.choices?.[0];
    const result: CompletionResult = {
      text: choice?.message?.content ?? '',
      model: completion.model ?? this.model,
      usage: toUsage(completion.usage),
    };
    if (choice?.finish_reason) result.stopReason = choice.finish_reason;
    return result;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const params = this.buildParams(request, true);

    let iterable: AsyncIterable<ChatChunk>;
    try {
      iterable = (await this.client.chat.completions.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      )) as AsyncIterable<ChatChunk>;
    } catch (err) {
      throw this.wrap(err, request);
    }

    let text = '';
    let model = this.model;
    let usage: ChatUsage | null | undefined;
    let stopReason: string | undefined;

    try {
      for await (const chunk of iterable) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          yield { type: 'text', text: delta };
        }
      }
    } catch (err) {
      throw this.wrap(err, request);
    }

    const result: CompletionResult = { text, model, usage: toUsage(usage) };
    if (stopReason) result.stopReason = stopReason;
    yield { type: 'done', result };
  }

  private wrap(err: unknown, request: CompletionRequest): Error {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | null)?.status;

    if (request.jsonSchema) {
      const namesSchema = /response_format|json_schema|schema/i.test(message);
      const rejected = this.dialect.lenientSchemaErrors && (status === 400 || status === 422);
      if (namesSchema || rejected) return new UnsupportedStructuredOutput(this.id, this.model);
    }

    return this.describeFailure({ status, message, err });
  }
}

/** True for a failure to reach the server at all, as opposed to an HTTP error. */
export function isConnectionFailure(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; cause?: unknown; message?: string };
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
  if (typeof e.code === 'string' && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(e.code)) {
    return true;
  }
  return e.cause !== undefined && e.cause !== err ? isConnectionFailure(e.cause) : false;
}

function toUsage(usage: ChatUsage | null | undefined): CompletionResult['usage'] {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // Cached tokens are counted inside prompt_tokens. Splitting them out lets
    // them be priced at the cache-read rate rather than the full input rate.
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}
