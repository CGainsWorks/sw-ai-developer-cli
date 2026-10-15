import OpenAI from 'openai';

import { ProviderError } from '../kernel/errors.js';
import {
  ChatCompletionsProvider,
  isConnectionFailure,
  type ChatCompletionsClientLike,
  type FailureContext,
} from './chat-completions.js';
import type { ProviderCreateOptions, ProviderFactory } from './types.js';

export const OPENAI_PROVIDER_ID = 'openai';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

/** The subset of the SDK client this provider uses, so tests can substitute it. */
export type OpenAIClientLike = ChatCompletionsClientLike;

export interface OpenAIProviderOptions extends ProviderCreateOptions {
  /** Injected in tests. */
  client?: OpenAIClientLike;
}

/** The hosted OpenAI API. */
export class OpenAIProvider extends ChatCompletionsProvider {
  readonly id = OPENAI_PROVIDER_ID;

  constructor(options: OpenAIProviderOptions) {
    super({
      model: options.model ?? process.env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL,
      maxTokens: options.maxTokens,
      client: options.client ?? createClient(options),
      // `max_completion_tokens` is the current field; `max_tokens` is rejected
      // by the newer reasoning models.
      dialect: { maxTokensField: 'max_completion_tokens', lenientSchemaErrors: false },
    });
  }

  protected describeFailure({ status, message, err }: FailureContext): ProviderError {
    if (status === 401 || status === 403) {
      return new ProviderError(this.id, `OpenAI rejected the API key (HTTP ${status})`, {
        cause: err,
        hint: `Check $${OPENAI_API_KEY_ENV}.`,
      });
    }
    if (status === 429) {
      return new ProviderError(this.id, 'OpenAI rate limit reached (HTTP 429)', {
        cause: err,
        hint: 'Retry shortly, or lower concurrency.',
      });
    }
    if (isConnectionFailure(err)) {
      return new ProviderError(this.id, `Could not reach OpenAI: ${message}`, {
        cause: err,
        hint: 'Check your network connection or proxy settings.',
      });
    }
    return new ProviderError(this.id, `OpenAI request failed: ${message}`, { cause: err });
  }
}

function createClient(options: OpenAIProviderOptions): OpenAIClientLike {
  const apiKey = options.apiKey ?? process.env[OPENAI_API_KEY_ENV];
  if (!apiKey) {
    throw new ProviderError(OPENAI_PROVIDER_ID, `No OpenAI API key found in $${OPENAI_API_KEY_ENV}`, {
      hint: `Export ${OPENAI_API_KEY_ENV}, or pass --provider compat to use a local or self-hosted model instead.`,
    });
  }
  return new OpenAI({
    apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  }) as unknown as OpenAIClientLike;
}

export const openaiProviderFactory: ProviderFactory = {
  id: OPENAI_PROVIDER_ID,
  defaultModel: OPENAI_DEFAULT_MODEL,
  apiKeyEnvVar: OPENAI_API_KEY_ENV,
  create: (options) => new OpenAIProvider(options),
};
