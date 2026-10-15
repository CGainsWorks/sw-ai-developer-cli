import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ExitCode } from '../kernel/exit-codes.js';
import { UsageError } from '../kernel/errors.js';
import { languageFor, readContextFiles } from '../kernel/input.js';
import { parseUnifiedDiff } from '../git/diff.js';
import { applyPatch, summarisePatch } from '../output/patch.js';
import {
  definePlugin,
  getBoolean,
  getString,
  getStringArray,
  PLUGIN_API_VERSION,
  type CommandContext,
  type CommandResult,
} from '../plugins/api.js';

export async function runGenerate(ctx: CommandContext): Promise<CommandResult> {
  const requestArg = ctx.args.request;
  const request = Array.isArray(requestArg) ? requestArg.join(' ') : (requestArg ?? '');
  if (request.trim() === '') {
    throw new UsageError('Describe what to generate, e.g. `swai generate "add a retry helper"`.');
  }

  const contextPaths = getStringArray(ctx.options, 'context');
  const outputPath = getString(ctx.options, 'output');
  const wantsApply = getBoolean(ctx.options, 'apply');
  const dryRun = getBoolean(ctx.options, 'dryRun');
  const patchMode = getBoolean(ctx.options, 'patch') || wantsApply || dryRun;

  if (wantsApply && dryRun) {
    throw new UsageError('--apply and --dry-run are mutually exclusive.');
  }
  if (!patchMode && (wantsApply || dryRun)) {
    throw new UsageError('--apply and --dry-run only apply in --patch mode.');
  }

  const context = await readContextFiles(ctx.cwd, contextPaths);

  return patchMode
    ? runPatchMode(ctx, { request, context, contextPaths, apply: wantsApply })
    : runPlainMode(ctx, { request, context, outputPath });
}

async function runPlainMode(
  ctx: CommandContext,
  opts: { request: string; context: string; outputPath?: string | undefined },
): Promise<CommandResult> {
  const language = getString(ctx.options, 'language') ?? (opts.outputPath ? languageFor(opts.outputPath) : '');

  const outputInstructions = opts.outputPath
    ? `Output only the complete contents of \`${opts.outputPath}\`. No Markdown fence, no commentary before or after.`
    : 'Output only code. No Markdown fence, no commentary before or after.';

  const prompt = await ctx.renderTemplate('generate', {
    request: opts.request,
    context: opts.context,
    outputInstructions: language
      ? `${outputInstructions} The language is ${language}.`
      : outputInstructions,
  });

  const modelRequest = {
    system: 'You are an experienced engineer writing production code for an existing codebase.',
    messages: [{ role: 'user' as const, content: prompt }],
    signal: ctx.signal,
  };

  // Streaming is on by default: generation is the long-running command, and a
  // blank terminal for 40 seconds reads as a hang.
  const result =
    ctx.config.stream && !opts.outputPath && !ctx.out.isJson
      ? await ctx.streamText(modelRequest)
      : await ctx.complete(modelRequest);

  const code = stripCodeFence(result.text);

  if (opts.outputPath) {
    const abs = resolve(ctx.cwd, opts.outputPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, code.endsWith('\n') ? code : code + '\n', 'utf8');
    ctx.logger.info(`Wrote ${opts.outputPath} (${code.length} bytes)`);
    ctx.out.line(ctx.out.green(`Wrote ${opts.outputPath}`));
    return {
      exitCode: ExitCode.Ok,
      data: { path: opts.outputPath, bytes: code.length },
      summary: `wrote ${opts.outputPath}`,
    };
  }

  // Already streamed to stdout, unless we took the non-streaming path.
  if (!ctx.config.stream || ctx.out.isJson) {
    ctx.out.line(code);
  } else if (!code.endsWith('\n')) {
    ctx.out.line();
  }

  return {
    exitCode: ExitCode.Ok,
    data: { code },
    summary: `generated ${code.length} bytes`,
  };
}

async function runPatchMode(
  ctx: CommandContext,
  opts: { request: string; context: string; contextPaths: string[]; apply: boolean },
): Promise<CommandResult> {
  if (opts.contextPaths.length === 0) {
    throw new UsageError('--patch needs at least one --context file to diff against.', {
      hint: 'Example: swai generate --patch --context src/app.ts "add input validation"',
    });
  }

  const prompt = await ctx.renderTemplate('generate-patch', {
    request: opts.request,
    context: opts.context,
  });

  const result = await ctx.complete({
    system:
      'You produce unified diffs that apply cleanly with `git apply`. You output the diff and nothing else.',
    messages: [{ role: 'user', content: prompt }],
    signal: ctx.signal,
  });

  const patchText = stripCodeFence(result.text);
  const files = parseUnifiedDiff(patchText);

  if (files.length === 0) {
    ctx.logger.error('The model did not return a parseable unified diff.');
    ctx.out.line(patchText);
    return {
      exitCode: ExitCode.PatchFailed,
      data: { patch: patchText, changes: [], rejected: [] },
      summary: 'no parseable diff returned',
    };
  }

  const dryRun = !opts.apply;
  const applied = await applyPatch(files, { cwd: ctx.cwd, dryRun });

  // Let plugins veto or rewrite the change set before anything touches disk.
  const changes = await ctx.hooks.beforePatch({ changes: applied.changes, dryRun });

  if (!dryRun && changes !== applied.changes) {
    // A hook altered the set after the write pass; re-apply the approved set.
    ctx.logger.debug('A plugin changed the patch set; re-writing the approved changes.');
    await applyPatch(files, { cwd: ctx.cwd, dryRun: true });
  }

  render(ctx, patchText, { ...applied, changes });

  const failed = applied.rejected.length > 0;
  const summary = summarisePatch({ ...applied, changes });

  return {
    exitCode: failed ? ExitCode.PatchFailed : ExitCode.Ok,
    data: {
      patch: patchText,
      dryRun,
      changes: changes.map((c) => ({ path: c.path, kind: c.kind })),
      rejected: applied.rejected.map((r) => ({ path: r.path, reason: r.reason })),
      skipped: applied.skipped,
    },
    summary,
  };
}

function render(
  ctx: CommandContext,
  patchText: string,
  applied: Awaited<ReturnType<typeof applyPatch>>,
): void {
  if (ctx.out.isJson) return;

  ctx.out.line(colourisePatch(ctx, patchText));
  ctx.out.line();

  for (const change of applied.changes) {
    const verb = applied.dryRun ? 'would ' : '';
    ctx.out.line(ctx.out.green(`  ${verb}${change.kind} ${change.path}`));
  }
  for (const reject of applied.rejected) {
    ctx.out.line(
      ctx.out.red(`  rejected hunk in ${reject.path} @@ -${reject.hunk.oldStart}: ${reject.reason}`),
    );
  }
  for (const skip of applied.skipped) {
    ctx.out.line(ctx.out.yellow(`  skipped ${skip.path}: ${skip.reason}`));
  }

  ctx.out.line();
  ctx.out.line(ctx.out.bold(summarisePatch(applied)));
  if (applied.dryRun && applied.changes.length > 0) {
    ctx.out.line(ctx.out.dim('Nothing was written. Re-run with --apply to write these changes.'));
  }
}

function colourisePatch(ctx: CommandContext, patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return ctx.out.bold(line);
      if (line.startsWith('@@')) return ctx.out.cyan(line);
      if (line.startsWith('+')) return ctx.out.green(line);
      if (line.startsWith('-')) return ctx.out.red(line);
      return line;
    })
    .join('\n');
}

/** Models wrap code in a fence far more often than they are told not to. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9+#._-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export default definePlugin({
  name: 'generate',
  apiVersion: PLUGIN_API_VERSION,
  description: 'Generates code, optionally as an applyable patch.',
  commands: [
    {
      name: 'generate',
      description: 'Generate code from a description',
      args: [
        {
          name: 'request',
          description: 'What to generate',
          required: true,
          variadic: true,
        },
      ],
      options: [
        { name: 'context', short: 'c', description: 'File to include as context (repeatable)', type: 'string[]' },
        { name: 'output', short: 'o', description: 'Write the result to this file', type: 'string' },
        { name: 'language', description: 'Language hint for the generated code', type: 'string' },
        { name: 'patch', description: 'Ask for a unified diff instead of a file body', type: 'boolean' },
        { name: 'apply', description: 'Apply the generated patch (implies --patch)', type: 'boolean' },
        {
          name: 'dry-run',
          description: 'Show what the patch would change and write nothing (the --patch default)',
          type: 'boolean',
        },
      ],
      examples: [
        'swai generate "a debounce helper" -o src/debounce.ts',
        'swai generate --patch -c src/server.ts "add a 30s request timeout"',
        'swai generate --apply -c src/server.ts "add a 30s request timeout"',
      ],
      run: runGenerate,
    },
  ],
});
