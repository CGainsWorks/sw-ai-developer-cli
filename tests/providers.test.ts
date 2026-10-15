import { describe, expect, it } from 'vitest';

import {
  COMPAT_API_KEY_ENV,
  COMPAT_DEFAULT_BASE_URL,
  COMPAT_DEFAULT_MODEL,
  COMPAT_DEFAULT_PRICE,
  CompatibleProvider,
  compatClientOptions,
  compatProviderFactory,
  resolveCompatSettings,
} from '../src/providers/compatible.js';
import { isConnectionFailure } from '../src/providers/chat-completions.js';
import { OpenAIProvider, openaiProviderFactory } from '../src/providers/openai.js';
import { UnsupportedStructuredOutput, drainStream } from '../src/providers/types.js';
import { ConfigError, ProviderError } from '../src/kernel/errors.js';
import type { OpenAIClientLike } from '../src/providers/openai.js';

const REQUEST = {
  system: 'be helpful',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

function openaiClient(
  create?: OpenAIClientLike['chat']['completions']['create'],
  model = 'gpt-4o',
) {
  const calls: Array<Record<string, unknown>> = [];
  const completion = {
    model,
    choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
  };

  const client: OpenAIClientLike = {
    chat: {
      completions: {
        create:
          create ??
          (async (params) => {
            calls.push(params);
            if (params.stream) {
              return (async function* () {
                yield { model, choices: [{ delta: { content: 'hi ' } }] };
                yield {
                  model,
                  choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }],
                };
                yield { model, choices: [], usage: completion.usage };
              })();
            }
            return completion;
          }),
      },
    },
  };
  return { client, calls };
}

describe('OpenAIProvider', () => {
  it('maps a completion and splits cached tokens out of the prompt count', async () => {
    const { client } = openaiClient();
    const result = await new OpenAIProvider({ client, maxTokens: 4096 }).complete(REQUEST);

    expect(result.text).toBe('hi there');
    expect(result.stopReason).toBe('stop');
    // 12 prompt tokens of which 2 were cached.
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
  });

  it('puts the system prompt in a system message and uses max_completion_tokens', async () => {
    const { client, calls } = openaiClient();
    await new OpenAIProvider({ client, maxTokens: 555 }).complete(REQUEST);

    expect(calls[0]?.max_completion_tokens).toBe(555);
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('requests strict json_schema when a schema is given', async () => {
    const { client, calls } = openaiClient();
    await new OpenAIProvider({ client, maxTokens: 100 }).complete({
      ...REQUEST,
      jsonSchema: { name: 'review', schema: { type: 'object' } },
    });
    expect(calls[0]?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'review', schema: { type: 'object' }, strict: true },
    });
  });

  it('asks for usage on streamed responses, which is otherwise omitted', async () => {
    const { client, calls } = openaiClient();
    const provider = new OpenAIProvider({ client, maxTokens: 100 });

    const chunks: string[] = [];
    const result = await drainStream(provider.stream(REQUEST), (t) => chunks.push(t));

    expect(calls[0]?.stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual(['hi ', 'there']);
    expect(result.text).toBe('hi there');
    expect(result.usage.outputTokens).toBe(4);
    expect(result.stopReason).toBe('stop');
  });

  it('signals an unsupported schema distinctly', async () => {
    const { client } = openaiClient(async () => {
      throw new Error('response_format json_schema is not supported');
    });
    await expect(
      new OpenAIProvider({ client, maxTokens: 100 }).complete({
        ...REQUEST,
        jsonSchema: { name: 'r', schema: {} },
      }),
    ).rejects.toBeInstanceOf(UnsupportedStructuredOutput);
  });

  it('maps auth and rate-limit failures to ProviderError', async () => {
    for (const [status, pattern] of [
      [403, /rejected the API key/],
      [429, /rate limit/],
      [500, /request failed/],
    ] as const) {
      const { client } = openaiClient(async () => {
        throw Object.assign(new Error('nope'), { status });
      });
      await expect(
        new OpenAIProvider({ client, maxTokens: 100 }).complete(REQUEST),
      ).rejects.toThrow(pattern);
    }
  });

  it('reports an unreachable API as a connection failure', async () => {
    const { client } = openaiClient(async () => {
      throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
    });
    await expect(new OpenAIProvider({ client, maxTokens: 100 }).complete(REQUEST)).rejects.toThrow(
      /Could not reach OpenAI/,
    );
  });

  it('refuses to construct without an API key', () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIProvider({ maxTokens: 100 })).toThrow(ProviderError);
    } finally {
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });

  it('exposes a factory', () => {
    expect(openaiProviderFactory.id).toBe('openai');
    expect(openaiProviderFactory.apiKeyEnvVar).toBe('OPENAI_API_KEY');
  });
});

describe('CompatibleProvider', () => {
  const MODEL = 'llama3.1:8b';

  const make = (
    create?: OpenAIClientLike['chat']['completions']['create'],
    extra: Partial<ConstructorParameters<typeof CompatibleProvider>[0]> = {},
  ) => {
    const fake = openaiClient(create, MODEL);
    const provider = new CompatibleProvider({
      client: fake.client,
      maxTokens: 321,
      env: {},
      model: MODEL,
      ...extra,
    });
    return { provider, calls: fake.calls };
  };

  it('maps a completion with the same token accounting as OpenAI', async () => {
    const { provider } = make();
    const result = await provider.complete(REQUEST);

    expect(result.text).toBe('hi there');
    expect(result.model).toBe(MODEL);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
  });

  it('sends max_tokens, which self-hosted servers understand', async () => {
    const { provider, calls } = make();
    await provider.complete(REQUEST);

    expect(calls[0]?.max_tokens).toBe(321);
    expect(calls[0]).not.toHaveProperty('max_completion_tokens');
    expect(calls[0]?.model).toBe(MODEL);
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('streams deltas and asks the server for usage', async () => {
    const { provider, calls } = make();
    const chunks: string[] = [];
    const result = await drainStream(provider.stream(REQUEST), (t) => chunks.push(t));

    expect(calls[0]?.stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual(['hi ', 'there']);
    expect(result.text).toBe('hi there');
    expect(result.usage.outputTokens).toBe(4);
  });

  it('reports zero tokens when a server streams without usage', async () => {
    const { provider } = make(async () =>
      (async function* () {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: null };
      })(),
    );
    const result = await drainStream(provider.stream(REQUEST));
    expect(result.text).toBe('ok');
    expect(result.model).toBe(MODEL);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('wraps a failure part-way through a stream', async () => {
    const { provider } = make(async () =>
      (async function* () {
        yield { choices: [{ delta: { content: 'par' } }] };
        throw Object.assign(new Error('boom'), { status: 500 });
      })(),
    );
    await expect(drainStream(provider.stream(REQUEST))).rejects.toThrow(/failed: boom/);
  });

  it('wraps a failure before a stream starts', async () => {
    const { provider } = make(async () => {
      throw Object.assign(new Error('nope'), { status: 503 });
    });
    await expect(drainStream(provider.stream(REQUEST))).rejects.toThrow(/failed: nope/);
  });

  it('treats a bare 400 or 422 on a schema request as "schema unsupported"', async () => {
    for (const status of [400, 422]) {
      const { provider } = make(async () => {
        throw Object.assign(new Error('bad request'), { status });
      });
      await expect(
        provider.complete({ ...REQUEST, jsonSchema: { name: 'r', schema: {} } }),
      ).rejects.toBeInstanceOf(UnsupportedStructuredOutput);
    }
  });

  it('does not mistake a 400 without a schema for a schema problem', async () => {
    const { provider } = make(async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps HTTP failures to ProviderError, naming the server', async () => {
    for (const [status, pattern] of [
      [401, /localhost:11434\/v1 rejected the API key/],
      [404, /Model "llama3\.1:8b" was not found/],
      [429, /Rate limit reached/],
      [500, /Request to the OpenAI-compatible server at .* failed: nope/],
    ] as const) {
      const { provider } = make(async () => {
        throw Object.assign(new Error('nope'), { status });
      });
      await expect(provider.complete(REQUEST)).rejects.toThrow(pattern);
    }
  });

  it('explains a refused connection, which usually means the server is not running', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
    });
    const { provider } = make(async () => {
      throw new Error('Connection error.', { cause: refused });
    });

    const err = await provider.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/Could not reach the OpenAI-compatible server/);
    expect((err as ProviderError).hint).toMatch(/ollama serve/);
  });

  it('declares a zero price by default and a configured one when given', () => {
    expect(make().provider.price).toEqual(COMPAT_DEFAULT_PRICE);
    const priced = make(undefined, {
      settings: { price: { input: 0.2, output: 0.6, cacheRead: 0.1, cacheWrite: 0.3 } },
    }).provider;
    expect(priced.price).toEqual({ input: 0.2, output: 0.6, cacheRead: 0.1, cacheWrite: 0.3 });
  });

  it('builds a real SDK client when none is injected, without needing a key', () => {
    const provider = new CompatibleProvider({ maxTokens: 100, env: {} });
    expect(provider.id).toBe('compat');
    expect(provider.model).toBe(COMPAT_DEFAULT_MODEL);
    expect(provider.baseUrl).toBe(COMPAT_DEFAULT_BASE_URL);
  });

  it('exposes a factory', () => {
    expect(compatProviderFactory.id).toBe('compat');
    expect(compatProviderFactory.defaultModel).toBe(COMPAT_DEFAULT_MODEL);
    expect(compatProviderFactory.apiKeyEnvVar).toBe(COMPAT_API_KEY_ENV);
  });
});

describe('resolveCompatSettings', () => {
  it('defaults to a local Ollama server, no key and zero cost', () => {
    expect(resolveCompatSettings({}, {})).toEqual({
      baseUrl: COMPAT_DEFAULT_BASE_URL,
      model: COMPAT_DEFAULT_MODEL,
      apiKeyEnv: COMPAT_API_KEY_ENV,
      apiKey: undefined,
      price: COMPAT_DEFAULT_PRICE,
    });
  });

  it('lets the environment override the config file and explicit options override both', () => {
    const settings = { baseUrl: 'http://file:1/v1', model: 'file-model', apiKeyEnv: 'FILE_KEY' };
    const env = {
      SWAI_COMPAT_BASE_URL: 'http://env:2/v1',
      SWAI_COMPAT_MODEL: 'env-model',
      SWAI_COMPAT_API_KEY_ENV: 'ENV_KEY',
      ENV_KEY: 'k-env',
      FILE_KEY: 'k-file',
    };

    expect(resolveCompatSettings({ settings }, { FILE_KEY: 'k-file' })).toMatchObject({
      baseUrl: 'http://file:1/v1',
      model: 'file-model',
      apiKeyEnv: 'FILE_KEY',
      apiKey: 'k-file',
    });
    expect(resolveCompatSettings({ settings }, env)).toMatchObject({
      baseUrl: 'http://env:2/v1',
      model: 'env-model',
      apiKeyEnv: 'ENV_KEY',
      apiKey: 'k-env',
    });
    expect(
      resolveCompatSettings(
        { settings, baseUrl: 'https://flag:3/v1', model: 'flag-model', apiKey: 'k-flag' },
        env,
      ),
    ).toMatchObject({ baseUrl: 'https://flag:3/v1', model: 'flag-model', apiKey: 'k-flag' });
  });

  it('ignores empty environment variables', () => {
    const resolved = resolveCompatSettings(
      {},
      { SWAI_COMPAT_BASE_URL: '  ', SWAI_COMPAT_API_KEY: '' },
    );
    expect(resolved.baseUrl).toBe(COMPAT_DEFAULT_BASE_URL);
    expect(resolved.apiKey).toBeUndefined();
  });

  it('reads the default key variable when it is set', () => {
    expect(resolveCompatSettings({}, { SWAI_COMPAT_API_KEY: 'secret' }).apiKey).toBe('secret');
  });

  it('requires a key once a key variable has been named', () => {
    expect(() => resolveCompatSettings({ settings: { apiKeyEnv: 'GATEWAY_KEY' } }, {})).toThrow(
      /No API key found in \$GATEWAY_KEY/,
    );
  });

  it('rejects malformed settings with a configuration error', () => {
    for (const settings of [
      { baseUrl: 42 },
      { model: '' },
      { baseUrl: 'not a url' },
      { baseUrl: 'ftp://host/v1' },
      { price: 'free' },
      { price: [] },
      { price: { input: -1, output: 0 } },
      { price: { input: 0 } },
      { price: { input: 0, output: 0, cacheRead: 'x' } },
    ]) {
      expect(() => resolveCompatSettings({ settings }, {})).toThrow(ConfigError);
    }
  });

  it('never forwards OpenAI account headers to a third-party server', () => {
    const options = compatClientOptions(resolveCompatSettings({}, {}), 5000);
    expect(options).toMatchObject({
      baseURL: COMPAT_DEFAULT_BASE_URL,
      organization: null,
      project: null,
      timeout: 5000,
    });
    expect(options?.apiKey).toBeTypeOf('string');
    expect(compatClientOptions(resolveCompatSettings({ apiKey: 'k' }, {}))).not.toHaveProperty(
      'timeout',
    );
  });
});

describe('isConnectionFailure', () => {
  it('recognises SDK connection errors and socket codes, directly or as a cause', () => {
    const timeout = Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' });
    const dns = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    const reset = Object.assign(new Error('y'), { code: 'ECONNRESET' });
    expect(isConnectionFailure(timeout)).toBe(true);
    expect(isConnectionFailure(dns)).toBe(true);
    expect(isConnectionFailure(new Error('wrapped', { cause: reset }))).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isConnectionFailure(null)).toBe(false);
    expect(isConnectionFailure('ECONNREFUSED')).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false);
  });
});

describe('drainStream', () => {
  it('throws if a provider stream ends without a final result', async () => {
    async function* broken() {
      yield { type: 'text' as const, text: 'partial' };
    }
    await expect(drainStream(broken())).rejects.toThrow(/without emitting a final result/);
  });
});
