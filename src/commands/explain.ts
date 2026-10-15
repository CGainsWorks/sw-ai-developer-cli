import { ExitCode } from '../kernel/exit-codes.js';
import { UsageError } from '../kernel/errors.js';
import { languageFor, readStdin, readTextFile } from '../kernel/input.js';
import {
  definePlugin,
  getString,
  PLUGIN_API_VERSION,
  type CommandContext,
  type CommandResult,
} from '../plugins/api.js';

const DETAIL_INSTRUCTIONS: Record<string, string> = {
  brief: 'Keep it to a single short paragraph. No headings, no bullet list.',
  normal: '',
  deep:
    'Go into depth: cover the data flow end to end, the failure modes, and how you would test it.',
};

export async function runExplain(ctx: CommandContext): Promise<CommandResult> {
  const fileArg = ctx.args.file;
  const path = typeof fileArg === 'string' ? fileArg : undefined;
  const lineRange = getString(ctx.options, 'lines');
  const detail = getString(ctx.options, 'detail') ?? 'normal';

  let code: string;
  let label: string;
  let language: string;

  if (path) {
    code = await readTextFile(ctx.cwd, path);
    label = `File: ${path}`;
    language = getString(ctx.options, 'language') ?? languageFor(path);
  } else {
    code = await readStdin();
    if (code.trim() === '') {
      throw new UsageError('Give a file to explain, or pipe code on stdin.', {
        hint: 'Example: swai explain src/app.ts   |   cat src/app.ts | swai explain',
      });
    }
    label = 'Code from stdin';
    language = getString(ctx.options, 'language') ?? '';
  }

  if (lineRange) {
    const sliced = sliceLines(code, lineRange);
    code = sliced.text;
    label = `${label} (lines ${sliced.start}-${sliced.end})`;
  }

  const prompt = await ctx.renderTemplate('explain', {
    code,
    label,
    language,
    detailInstructions: DETAIL_INSTRUCTIONS[detail] ?? '',
  });

  const modelRequest = {
    system: 'You explain code accurately and without padding.',
    messages: [{ role: 'user' as const, content: prompt }],
    signal: ctx.signal,
  };

  const result =
    ctx.config.stream && !ctx.out.isJson
      ? await ctx.streamText(modelRequest)
      : await ctx.complete(modelRequest);

  if (!ctx.config.stream || ctx.out.isJson) {
    ctx.out.line(result.text);
  } else if (!result.text.endsWith('\n')) {
    ctx.out.line();
  }

  return {
    exitCode: ExitCode.Ok,
    data: { explanation: result.text, source: path ?? '<stdin>' },
    summary: `explained ${path ?? 'stdin'}`,
  };
}

/** Parses `12:40`, `12-40` or `12` into an inclusive, 1-based slice. */
export function sliceLines(
  code: string,
  range: string,
): { text: string; start: number; end: number } {
  const match = /^(\d+)(?:\s*[:-]\s*(\d+))?$/.exec(range.trim());
  if (!match) {
    throw new UsageError(`Could not parse --lines "${range}". Use START:END, e.g. 12:40.`);
  }

  const lines = code.split(/\r?\n/);
  const start = Math.max(1, Number(match[1]));

  // Check the start against the file before clamping the end, or an
  // out-of-range start is reported as an inverted range.
  if (start > lines.length) {
    throw new UsageError(
      `--lines "${range}" starts past the end of the input (${lines.length} lines).`,
    );
  }

  const end = match[2] === undefined ? start : Math.min(lines.length, Number(match[2]));
  if (end < start) {
    throw new UsageError(`--lines "${range}" ends before it starts.`);
  }

  return { text: lines.slice(start - 1, end).join('\n'), start, end };
}

export default definePlugin({
  name: 'explain',
  apiVersion: PLUGIN_API_VERSION,
  description: 'Explains a file or piped code.',
  commands: [
    {
      name: 'explain',
      description: 'Explain a file, or code piped on stdin',
      args: [{ name: 'file', description: 'File to explain (omit to read stdin)' }],
      options: [
        { name: 'lines', short: 'l', description: 'Only explain a line range, e.g. 12:40', type: 'string' },
        {
          name: 'detail',
          short: 'd',
          description: 'How much detail to go into',
          type: 'string',
          choices: ['brief', 'normal', 'deep'],
          default: 'normal',
        },
        { name: 'language', description: 'Language hint when reading from stdin', type: 'string' },
      ],
      examples: [
        'swai explain src/kernel/hooks.ts',
        'swai explain src/output/patch.ts --lines 120:180 --detail deep',
        'cat script.py | swai explain --language python',
      ],
      run: runExplain,
    },
  ],
});
