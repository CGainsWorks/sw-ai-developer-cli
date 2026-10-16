/**
 * A mock OpenAI-compatible server for tests and CI.
 *
 * It speaks the subset of the Chat Completions API that the `compat` provider
 * uses: `POST /v1/chat/completions` (plain and streamed as server-sent
 * events, with `stream_options.include_usage`) and `GET /v1/models`. It is a
 * stand-in for Ollama, vLLM or LM Studio, so the real OpenAI SDK, the real
 * HTTP stack and the real CLI can be exercised with no model, no key and no
 * network beyond the loopback interface.
 *
 * Responses are deterministic. Token counts are a simple estimate (one token
 * per four characters) so that usage accounting has something non-zero to
 * report; they are not a model's real counts.
 *
 * It can also be run on its own:
 *
 *   node tests/mock-openai/server.mjs [port]
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_MODEL = 'mock-coder';

const DEFAULT_TEXT = 'Mock response from the OpenAI-compatible test server.';

/**
 * Starts the server on 127.0.0.1.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 (the default) picks a free port.
 * @param {string[]} [options.models] Models it serves; any other is a 404.
 * @param {string} [options.apiKey] When set, requests must carry this bearer token.
 * @param {boolean} [options.rejectSchema] Answer `response_format: json_schema` with HTTP 400.
 * @param {boolean} [options.omitUsage] Leave usage out of streamed responses.
 * @param {number} [options.failStatus] Answer every completion with this HTTP status.
 * @param {(body: any) => string} [options.respond] Overrides the response text.
 */
export async function startMockOpenAI(options = {}) {
  const models = options.models ?? [MOCK_MODEL];
  const requests = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        handle(req, res, raw);
      } catch (err) {
        sendError(res, 500, `mock server error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  function handle(req, res, raw) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })),
      });
      return;
    }

    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      sendError(res, 404, `No route for ${req.method} ${path}`);
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(res, 400, 'Request body is not valid JSON');
      return;
    }
    requests.push({ headers: { ...req.headers }, body });

    if (options.failStatus) {
      sendError(res, options.failStatus, `mock failure with HTTP ${options.failStatus}`);
      return;
    }
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      sendError(res, 401, 'Incorrect API key provided', 'invalid_api_key');
      return;
    }
    if (typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
      sendError(res, 400, 'model and a non-empty messages array are required');
      return;
    }
    if (!models.includes(body.model)) {
      sendError(res, 404, `model "${body.model}" not found`, 'model_not_found');
      return;
    }
    // Worded without naming the schema, as some self-hosted servers do, so
    // the provider's lenient handling of a bare 400 is what gets tested.
    if (options.rejectSchema && body.response_format?.type === 'json_schema') {
      sendError(res, 400, 'Invalid request: unsupported parameter');
      return;
    }

    const text = options.respond ? options.respond(body) : defaultResponse(body);
    const promptChars = body.messages.reduce(
      (total, m) => total + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    const usage = {
      prompt_tokens: estimateTokens(promptChars),
      completion_tokens: estimateTokens(text.length),
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    const id = `chatcmpl-mock-${requests.length}`;

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (choices, extra = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices, ...extra })}\n\n`,
        );
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
      for (const part of text.split(/(?<=\s)/)) {
        if (part) chunk([{ index: 0, delta: { content: part }, finish_reason: null }]);
      }
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      if (body.stream_options?.include_usage && !options.omitUsage) chunk([], { usage });
      res.end('data: [DONE]\n\n');
      return;
    }

    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * A review prompt gets one error-level finding on the first added line of
 * the diff; a commit message prompt gets a Conventional Commits subject;
 * anything else gets a fixed sentence.
 */
function defaultResponse(body) {
  const prompt = body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

  if (prompt.includes('Diff under review')) {
    const target = firstAddedLine(prompt);
    const comments = target
      ? [
          {
            file: target.file,
            line: target.line,
            severity: 'error',
            category: 'correctness',
            message: `Mock finding on the first added line of ${target.file}.`,
            suggestion: null,
          },
        ]
      : [];
    return JSON.stringify({ comments });
  }
  if (prompt.includes('Conventional Commits')) return 'chore(mock): message from the mock server';
  return DEFAULT_TEXT;
}

/**
 * The file and new-side line number of the first added line, read either
 * from the CLI's annotated review format (`--- path ---` then `   12+| code`)
 * or from a plain unified diff.
 */
export function firstAddedLine(text) {
  let file;
  let line = 0;
  let inHunk = false;
  for (const row of text.split('\n')) {
    const annotatedHeader = /^--- (.+?) ---$/.exec(row);
    if (annotatedHeader) {
      file = annotatedHeader[1];
      inHunk = false;
      continue;
    }
    const annotated = /^\s*(\d+)\+\| /.exec(row);
    if (annotated && file) return { file, line: Number(annotated[1]) };

    const header = /^\+\+\+ b\/(.+)$/.exec(row);
    if (header) {
      file = header[1].trim();
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (row.startsWith('+')) return { file, line };
    if (!row.startsWith('-')) line++;
  }
  return undefined;
}

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, code = null) {
  sendJson(res, status, { error: { message, type: 'invalid_request_error', param: null, code } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startMockOpenAI({ port: Number(process.argv[2] ?? 0) });
  console.log(`mock OpenAI-compatible server listening on ${server.url}`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
