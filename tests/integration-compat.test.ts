/**
 * The `compat` provider against a mock OpenAI-compatible server over real
 * HTTP, with the real OpenAI SDK.
 *
 * The unit tests in providers.test.ts substitute the SDK client. These do not:
 * every request here is serialised by the SDK, sent over the loopback
 * interface and parsed back, including server-sent events for streaming. The
 * last two tests drive the whole CLI the same way.
 */
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/run.js';
import { ExitCode } from '../src/kernel/exit-codes.js';
import { ProviderError } from '../src/kernel/errors.js';
import { CompatibleProvider } from '../src/providers/compatible.js';
import { UnsupportedStructuredOutput, drainStream } from '../src/providers/types.js';
import { MOCK_MODEL, firstAddedLine, startMockOpenAI, type MockOpenAIServer } from './mock-openai/server.mjs';
import { makeSink, makeTempDir, type TempDir } from './helpers.js';

const REQUEST = {
  system: 'be brief',
  messages: [{ role: 'user' as const, content: 'say something' }],
};

const DIFF = [
  'diff --git a/src/cart.js b/src/cart.js',
  '--- a/src/cart.js',
  '+++ b/src/cart.js',
  '@@ -1,3 +1,4 @@',
  ' export function total(items) {',
  '   let sum = 0;',
  '+  for (const item of items) sum += item.price;',
  '   return sum;',
  '',
].join('\n');

/** Environment variables the SDK or the provider read from process.env. */
const ENV_KEYS = [
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'SWAI_COMPAT_BASE_URL',
  'SWAI_COMPAT_MODEL',
  'SWAI_COMPAT_API_KEY',
  'SWAI_COMPAT_API_KEY_ENV',
] as const;

describe('compat provider against a mock OpenAI-compatible server', () => {
  let server: MockOpenAIServer | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const provider = (url: string, extra: Partial<ConstructorParameters<typeof CompatibleProvider>[0]> = {}) =>
    new CompatibleProvider({ baseUrl: url, model: MOCK_MODEL, maxTokens: 256, env: {}, ...extra });

  it('completes a request and reports the server usage', async () => {
    server = await startMockOpenAI();
    const result = await provider(server.url).complete(REQUEST);

    expect(result.text).toBe('Mock response from the OpenAI-compatible test server.');
    expect(result.model).toBe(MOCK_MODEL);
    expect(result.stopReason).toBe('stop');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    const [sent] = server.requests;
    expect(sent?.body).toMatchObject({
      model: MOCK_MODEL,
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'say something' },
      ],
    });
    expect(sent?.body).not.toHaveProperty('max_completion_tokens');
    expect(sent?.body).not.toHaveProperty('stream');
  });

  it('streams over server-sent events and still counts tokens', async () => {
    server = await startMockOpenAI();
    const deltas: string[] = [];
    const result = await drainStream(provider(server.url).stream(REQUEST), (text) => {
      deltas.push(text);
    });

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(result.text);
    expect(result.text).toBe('Mock response from the OpenAI-compatible test server.');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(server.requests[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('records zero tokens when a streaming server reports no usage', async () => {
    server = await startMockOpenAI({ omitUsage: true });
    const result = await drainStream(provider(server.url).stream(REQUEST));
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('never forwards OpenAI organisation or project ids to the server', async () => {
    process.env.OPENAI_ORG_ID = 'org-should-not-leak';
    process.env.OPENAI_PROJECT_ID = 'proj-should-not-leak';
    server = await startMockOpenAI();
    await provider(server.url).complete(REQUEST);

    const headers = server.requests[0]?.headers ?? {};
    expect(headers['openai-organization']).toBeUndefined();
    expect(headers['openai-project']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('should-not-leak');
  });

  it('sends a placeholder bearer token when no key is configured', async () => {
    server = await startMockOpenAI();
    await provider(server.url).complete(REQUEST);
    expect(server.requests[0]?.headers.authorization).toBe('Bearer not-needed');
  });

  it('sends the key from the named variable and maps a rejected key to a clear error', async () => {
    server = await startMockOpenAI({ apiKey: 'right-key' });

    const ok = await provider(server.url, { env: { MY_GATEWAY_KEY: 'right-key', SWAI_COMPAT_API_KEY_ENV: 'MY_GATEWAY_KEY' } }).complete(REQUEST);
    expect(ok.text.length).toBeGreaterThan(0);

    const err = await provider(server.url, { env: { SWAI_COMPAT_API_KEY: 'wrong-key' } })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/rejected the API key \(HTTP 401\)/);
  });

  it('reports an unknown model as a 404 with a hint', async () => {
    server = await startMockOpenAI();
    const err = await provider(server.url, { model: 'no-such-model' })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/Model "no-such-model" was not found .* \(HTTP 404\)/);
  });

  it('treats a bare HTTP 400 on a schema-constrained request as unsupported structured output', async () => {
    server = await startMockOpenAI({ rejectSchema: true });
    const err = await provider(server.url)
      .complete({ ...REQUEST, jsonSchema: { name: 'x', schema: { type: 'object' } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedStructuredOutput);
  });

  it('reports a server that is not running as unreachable', async () => {
    const port = await closedPort();
    const err = await provider(`http://127.0.0.1:${port}/v1`, { timeoutMs: 2000 })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/Could not reach the OpenAI-compatible server/);
  });

  it('retries a rate limit twice inside the SDK before surfacing it', async () => {
    server = await startMockOpenAI({ failStatus: 429 });
    const err = await provider(server.url)
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/Rate limit reached .* \(HTTP 429\)/);
    // The OpenAI SDK's default: one attempt plus two retries with backoff.
    expect(server.requests).toHaveLength(3);
  });

  describe('through the CLI', () => {
    let dir: TempDir;

    beforeEach(() => {
      dir = makeTempDir('swai-compat-');
    });
    afterEach(() => dir.cleanup());

    async function run(argv: string[]) {
      const out = makeSink();
      const err = makeSink();
      const code = await runCli({
        argv: ['--cwd', dir.path, '--no-color', ...argv],
        cwd: dir.path,
        env: {},
        stdout: out.write,
        stderr: (line) => err.write(line + '\n'),
      });
      return { code, stdout: out.text(), stderr: err.text() };
    }

    it('reviews a diff from a config file and gates on the finding', async () => {
      server = await startMockOpenAI({ rejectSchema: true });
      dir.file(
        'swai.config.json',
        JSON.stringify({ provider: 'compat', providerConfig: { compat: { baseUrl: server.url, model: MOCK_MODEL } } }),
      );
      dir.file('change.diff', DIFF);

      const { code, stdout } = await run(['review', '--patch-file', 'change.diff', '--json']);

      expect(code).toBe(ExitCode.Findings);
      const doc = JSON.parse(stdout);
      expect(doc.comments).toHaveLength(1);
      expect(doc.comments[0]).toMatchObject({ file: 'src/cart.js', line: 3, severity: 'error' });
      // The schema was refused, so the review retried unconstrained and still succeeded.
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]?.body.response_format?.type).toBe('json_schema');
      expect(server.requests[1]?.body).not.toHaveProperty('response_format');
      // Only the call that returned is counted; the refused one reported no usage.
      expect(doc.usage.calls).toBe(1);
      expect(doc.usage.inputTokens).toBeGreaterThan(0);
      expect(doc.usage.costUsd).toBe(0);
    });

    it('streams an explanation using settings from the environment', async () => {
      server = await startMockOpenAI();
      process.env.SWAI_COMPAT_BASE_URL = server.url;
      process.env.SWAI_COMPAT_MODEL = MOCK_MODEL;
      dir.file('src/cart.js', 'export const total = (items) => items.length;\n');

      const { code, stdout } = await run(['--no-config', '--provider', 'compat', 'explain', 'src/cart.js']);

      expect(code).toBe(ExitCode.Ok);
      expect(stdout).toContain('Mock response from the OpenAI-compatible test server.');
      expect(server.requests[0]?.body.stream).toBe(true);
    });
  });
});

describe('mock server diff helper', () => {
  it('finds the first added line on the new side of the diff', () => {
    expect(firstAddedLine(DIFF)).toEqual({ file: 'src/cart.js', line: 3 });
    const annotated = ['--- src/a.ts ---', '@@', '     7 | const a = 1;', '     8+| const b = 2;'].join('\n');
    expect(firstAddedLine(annotated)).toEqual({ file: 'src/a.ts', line: 8 });
    expect(firstAddedLine('no diff here')).toBeUndefined();
  });
});

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
