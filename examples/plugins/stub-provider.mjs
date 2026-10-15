/**
 * An out-of-tree plugin, used by `make demo`.
 *
 * It registers a `stub` provider that returns canned responses instead of
 * calling a model. That makes the demo runnable with no API key and no
 * network, and every number it prints reproducible.
 *
 * It is also the smallest complete example of the two things the plugin API
 * exists for: contributing a provider, and contributing a command. Nothing
 * here imports from the CLI's internals — a plugin only needs a plain object
 * of the right shape.
 */

const PLUGIN_API_VERSION = 1;

/** Canned responses, keyed by the command that asked for them. */
const RESPONSES = {
  review: JSON.stringify({
    comments: [
      {
        file: 'src/cart.js',
        line: 8,
        severity: 'error',
        category: 'correctness',
        message:
          '`total` accumulates `item.price` but ignores `item.quantity`, so any ' +
          'line with a quantity above 1 is undercharged.',
        suggestion: '    total += item.price * item.quantity;',
      },
      {
        file: 'src/cart.js',
        line: 12,
        severity: 'warning',
        category: 'correctness',
        message:
          'A discount code of 0 is falsy, so `if (discount)` silently skips a ' +
          'legitimate 0% code instead of applying it.',
        suggestion: null,
      },
    ],
  }),

  generate: [
    'export function retry(fn, { attempts = 3, delayMs = 100 } = {}) {',
    '  return async (...args) => {',
    '    let lastError;',
    '    for (let attempt = 0; attempt < attempts; attempt++) {',
    '      try {',
    '        return await fn(...args);',
    '      } catch (error) {',
    '        lastError = error;',
    '        if (attempt < attempts - 1) {',
    '          await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));',
    '        }',
    '      }',
    '    }',
    '    throw lastError;',
    '  };',
    '}',
  ].join('\n'),

  explain:
    'It totals a shopping cart and applies a percentage discount.\n\n' +
    'The loop sums `item.price` for each line but never multiplies by ' +
    '`item.quantity`, so the total is only correct when every quantity is 1. ' +
    'The discount branch uses a truthiness check, which treats a 0% code as ' +
    '"no code supplied" — harmless today, but wrong the moment 0 is a valid ' +
    'discount rather than a sentinel.',

  'commit-msg': 'fix(cart): multiply line price by quantity when totalling',
};

const DEFAULT_RESPONSE = '// The stub provider has no canned response for this command.';

/** Rough token estimate, so the cost accounting in the demo is not fabricated. */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function makeStubProvider({ model = 'stub-1', maxTokens }) {
  const buildResult = (request) => {
    const command = request.__command ?? detectCommand(request);
    const text = RESPONSES[command] ?? DEFAULT_RESPONSE;
    const promptLength =
      (request.system?.length ?? 0) +
      request.messages.reduce((total, m) => total + m.content.length, 0);

    return {
      text,
      model,
      usage: {
        inputTokens: estimateTokens('x'.repeat(promptLength)),
        outputTokens: estimateTokens(text),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      stopReason: 'end_turn',
    };
  };

  return {
    id: 'stub',
    model,
    maxTokens,
    async complete(request) {
      return buildResult(request);
    },
    async *stream(request) {
      const result = buildResult(request);
      // Emit in chunks so the streaming renderer is actually exercised.
      for (const word of result.text.split(/(\s+)/)) {
        if (word) yield { type: 'text', text: word };
      }
      yield { type: 'done', result };
    },
  };
}

/**
 * The provider only sees a prompt, so the demo tags each request with the
 * command that produced it via a `beforeModelCall` hook.
 */
function detectCommand(request) {
  const prompt = request.messages.map((m) => m.content).join('\n');
  if (prompt.includes('Diff under review')) return 'review';
  if (prompt.includes('Conventional Commits')) return 'commit-msg';
  if (prompt.includes('Explain the code below')) return 'explain';
  return 'generate';
}

export default {
  name: 'stub-provider',
  apiVersion: PLUGIN_API_VERSION,
  version: '1.0.0',
  description: 'A deterministic offline provider, plus a `stub-info` command. Used by `make demo`.',

  providers: [
    {
      id: 'stub',
      defaultModel: 'stub-1',
      apiKeyEnvVar: 'STUB_API_KEY_NOT_REQUIRED',
      create: (options) => makeStubProvider(options),
    },
  ],

  hooks: {
    beforeModelCall({ command, request }) {
      // Returning a value replaces the request for every later hook and for
      // the provider. Returning nothing would leave it untouched.
      return { ...request, __command: command };
    },
  },

  commands: [
    {
      name: 'stub-info',
      description: 'Show which commands the stub provider has canned responses for',
      // Note: not `--quiet` or `--verbose`. Those are reserved global flags,
      // and the loader rejects a plugin that tries to claim one — see
      // RESERVED_OPTION_NAMES in the plugin guide.
      options: [
        { name: 'count-only', short: 'c', description: 'Only print the count', type: 'boolean' },
      ],
      run(ctx) {
        const commands = Object.keys(RESPONSES).sort();
        if (!ctx.out.isJson) {
          if (ctx.options.countOnly === true) {
            ctx.out.line(String(commands.length));
          } else {
            ctx.out.line('The stub provider answers these commands offline:');
            for (const name of commands) ctx.out.line(`  - ${name}`);
          }
        }
        return {
          exitCode: 0,
          data: { commands },
          summary: `${commands.length} canned responses`,
        };
      },
    },
  ],
};
