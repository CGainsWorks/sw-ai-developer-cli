/**
 * The `compat` provider: any server that speaks the OpenAI Chat Completions
 * wire format.
 *
 * That covers Ollama, vLLM, LM Studio, llama.cpp's server and most hosted
 * gateways. Point it at a server on your own machine or network and no code
 * leaves it.
 *
 * Settings, highest precedence first:
 *
 *   base URL   SWAI_COMPAT_BASE_URL, then providerConfig.compat.baseUrl,
 *              then http://localhost:11434/v1 (Ollama's default)
 *   model      --model / SWAI_MODEL / "model", then SWAI_COMPAT_MODEL,
 *              then providerConfig.compat.model, then a small coding model
 *   key        read from the variable named by SWAI_COMPAT_API_KEY_ENV or
 *              providerConfig.compat.apiKeyEnv, default SWAI_COMPAT_API_KEY.
 *              Optional, because local servers usually ignore it.
 *   price      providerConfig.compat.price, default zero. A `pricing` entry
 *              for the model in the config still wins.
 */
import OpenAI from 'openai';

import { ConfigError, ProviderError } from '../kernel/errors.js';
import {
  ChatCompletionsProvider,
  isConnectionFailure,
  type ChatCompletionsClientLike,
  type FailureContext,
} from './chat-completions.js';
import type { ModelPrice } from './pricing.js';
import type { ProviderCreateOptions, ProviderFactory } from './types.js';

export const COMPAT_PROVIDER_ID = 'compat';
export const COMPAT_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const COMPAT_DEFAULT_MODEL = 'qwen2.5-coder:7b';
export const COMPAT_API_KEY_ENV = 'SWAI_COMPAT_API_KEY';

/** Environment variables the provider reads. */
export const COMPAT_ENV = {
  baseUrl: 'SWAI_COMPAT_BASE_URL',
  model: 'SWAI_COMPAT_MODEL',
  apiKeyEnv: 'SWAI_COMPAT_API_KEY_ENV',
} as const;

/** A local model has no per-token bill. */
export const COMPAT_DEFAULT_PRICE: ModelPrice = { input: 0, output: 0 };

/**
 * The SDK refuses to construct without a key. Local servers ignore the
 * header, so a keyless setup sends this instead.
 */
const NO_KEY = 'not-needed';

/** The shape of `providerConfig.compat` in the config file. */
export interface CompatSettings {
  baseUrl?: string;
  model?: string;
  /** Name of the environment variable holding the key, not the key itself. */
  apiKeyEnv?: string;
  /** USD per 1M tokens, applied to every model served through this provider. */
  price?: ModelPrice;
}

export interface ResolvedCompatSettings {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string | undefined;
  price: ModelPrice;
}

export interface CompatibleProviderOptions extends ProviderCreateOptions {
  /** Injected in tests. */
  client?: ChatCompletionsClientLike;
  /** Defaults to process.env; injected in tests. */
  env?: NodeJS.ProcessEnv;
}

export class CompatibleProvider extends ChatCompletionsProvider {
  readonly id = COMPAT_PROVIDER_ID;
  readonly baseUrl: string;
  readonly price: ModelPrice;

  private readonly apiKeyEnv: string;

  constructor(options: CompatibleProviderOptions) {
    const resolved = resolveCompatSettings(options, options.env ?? process.env);
    super({
      model: resolved.model,
      maxTokens: options.maxTokens,
      client: options.client ?? createClient(resolved, options.timeoutMs),
      // `max_tokens` is the field self-hosted servers understand.
      dialect: { maxTokensField: 'max_tokens', lenientSchemaErrors: true },
    });
    this.baseUrl = resolved.baseUrl;
    this.price = resolved.price;
    this.apiKeyEnv = resolved.apiKeyEnv;
  }

  protected describeFailure({ status, message, err }: FailureContext): ProviderError {
    const where = `the OpenAI-compatible server at ${this.baseUrl}`;

    if (isConnectionFailure(err)) {
      return new ProviderError(this.id, `Could not reach ${where}: ${message}`, {
        cause: err,
        hint: `Start the server (for example \`ollama serve\`), or set ${COMPAT_ENV.baseUrl} to where it runs.`,
      });
    }
    if (status === 401 || status === 403) {
      return new ProviderError(this.id, `${capitalise(where)} rejected the API key (HTTP ${status})`, {
        cause: err,
        hint: `Put the key in $${this.apiKeyEnv}, or name another variable with ${COMPAT_ENV.apiKeyEnv}.`,
      });
    }
    if (status === 404) {
      return new ProviderError(this.id, `Model "${this.model}" was not found at ${where} (HTTP 404)`, {
        cause: err,
        hint:
          'Check the model name and that the base URL ends in /v1. ' +
          `With Ollama, \`ollama pull ${this.model}\` fetches it.`,
      });
    }
    if (status === 429) {
      return new ProviderError(this.id, `Rate limit reached at ${where} (HTTP 429)`, {
        cause: err,
        hint: 'Retry shortly, or lower concurrency.',
      });
    }
    return new ProviderError(this.id, `Request to ${where} failed: ${message}`, { cause: err });
  }
}

/**
 * Works out the effective settings. Exported so the precedence rules can be
 * tested without a network.
 */
export function resolveCompatSettings(
  options: Pick<ProviderCreateOptions, 'model' | 'apiKey' | 'baseUrl' | 'settings'>,
  env: NodeJS.ProcessEnv,
): ResolvedCompatSettings {
  const settings = readSettings(options.settings ?? {});

  const baseUrl =
    options.baseUrl ?? nonEmpty(env[COMPAT_ENV.baseUrl]) ?? settings.baseUrl ?? COMPAT_DEFAULT_BASE_URL;
  assertUrl(baseUrl);

  const apiKeyEnv = nonEmpty(env[COMPAT_ENV.apiKeyEnv]) ?? settings.apiKeyEnv ?? COMPAT_API_KEY_ENV;
  const apiKey = options.apiKey ?? nonEmpty(env[apiKeyEnv]);

  // Naming a variable is a statement that the server needs a key, so a
  // missing one is reported now rather than as a puzzling 401 later.
  if (!apiKey && apiKeyEnv !== COMPAT_API_KEY_ENV) {
    throw new ProviderError(COMPAT_PROVIDER_ID, `No API key found in $${apiKeyEnv}`, {
      hint: `Export ${apiKeyEnv}, or remove apiKeyEnv for a server that needs no key.`,
    });
  }

  return {
    baseUrl,
    model:
      options.model ?? nonEmpty(env[COMPAT_ENV.model]) ?? settings.model ?? COMPAT_DEFAULT_MODEL,
    apiKeyEnv,
    apiKey,
    price: settings.price ?? COMPAT_DEFAULT_PRICE,
  };
}

/** SDK options for a resolved configuration. Exported for tests. */
export function compatClientOptions(
  resolved: ResolvedCompatSettings,
  timeoutMs?: number,
): ConstructorParameters<typeof OpenAI>[0] {
  return {
    apiKey: resolved.apiKey ?? NO_KEY,
    baseURL: resolved.baseUrl,
    // Explicit nulls stop the SDK picking up OPENAI_ORG_ID and
    // OPENAI_PROJECT_ID and sending OpenAI account details to a third party.
    organization: null,
    project: null,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  };
}

function createClient(
  resolved: ResolvedCompatSettings,
  timeoutMs: number | undefined,
): ChatCompletionsClientLike {
  return new OpenAI(compatClientOptions(resolved, timeoutMs)) as unknown as ChatCompletionsClientLike;
}

function readSettings(raw: Record<string, unknown>): CompatSettings {
  const out: CompatSettings = {};
  for (const key of ['baseUrl', 'model', 'apiKeyEnv'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(`providerConfig.compat.${key} must be a non-empty string`);
    }
    out[key] = value;
  }
  if (raw.price !== undefined) out.price = readPrice(raw.price);
  return out;
}

function readPrice(value: unknown): ModelPrice {
  const problem = 'providerConfig.compat.price must look like { "input": 0, "output": 0 }';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(problem);
  }
  const price = value as Record<string, unknown>;
  const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isRate(price.input) || !isRate(price.output)) {
    throw new ConfigError(problem, { hint: 'Rates are USD per 1M tokens and cannot be negative.' });
  }
  const out: ModelPrice = { input: price.input, output: price.output };
  for (const key of ['cacheRead', 'cacheWrite'] as const) {
    if (price[key] === undefined) continue;
    const rate = price[key];
    if (!isRate(rate)) throw new ConfigError(`providerConfig.compat.price.${key} must be a non-negative number`);
    out[key] = rate;
  }
  return out;
}

function assertUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Invalid base URL for the compat provider: "${value}"`, {
      hint: 'Use a full URL such as http://localhost:11434/v1.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`The compat provider's base URL must be http or https, got "${value}"`);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const compatProviderFactory: ProviderFactory = {
  id: COMPAT_PROVIDER_ID,
  defaultModel: COMPAT_DEFAULT_MODEL,
  apiKeyEnvVar: COMPAT_API_KEY_ENV,
  create: (options) => new CompatibleProvider(options),
};
