import { ExitCode } from '../kernel/exit-codes.js';
import { UsageError } from '../kernel/errors.js';
import { extractJson } from '../kernel/json.js';
import { readStdin, readTextFile } from '../kernel/input.js';
import { GitRepo } from '../git/repo.js';
import {
  annotateForReview,
  changedLineNumbers,
  diffStats,
  parseUnifiedDiff,
  targetPath,
  type FileDiff,
} from '../git/diff.js';
import { UnsupportedStructuredOutput } from '../providers/types.js';
import { SEVERITIES, type FailOn, type Severity } from '../config/types.js';
import {
  definePlugin,
  getBoolean,
  getString,
  getStringArray,
  PLUGIN_API_VERSION,
  type CommandContext,
  type CommandResult,
  type ReviewComment,
} from '../plugins/api.js';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['comments'],
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // Every key is required, with nullable unions for the optional ones:
        // OpenAI's strict mode rejects a schema where a declared property is
        // absent from `required`.
        required: ['file', 'line', 'severity', 'category', 'message', 'suggestion'],
        properties: {
          file: { type: 'string', description: 'Path exactly as it appears in the diff' },
          line: { type: 'integer', description: 'Post-change line number, or 0 for file-level' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          category: {
            type: 'string',
            description: 'Short slug, e.g. correctness, security, performance, api-contract',
          },
          message: { type: 'string' },
          suggestion: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Replacement snippet, or null',
          },
        },
      },
    },
  },
} as const;

export async function runReview(ctx: CommandContext): Promise<CommandResult> {
  const patchFile = getString(ctx.options, 'patchFile');
  const useStdin = getBoolean(ctx.options, 'stdin');
  const staged = getBoolean(ctx.options, 'staged');
  const base = getString(ctx.options, 'base');
  const paths = getStringArray(ctx.options, 'path');

  const rawDiff = await resolveDiff(ctx, { patchFile, useStdin, staged, base, paths });

  if (rawDiff.trim() === '') {
    ctx.logger.info('No changes to review.');
    ctx.out.json({ comments: [], stats: { files: 0, additions: 0, deletions: 0 } });
    return { exitCode: ExitCode.Ok, summary: 'no changes to review' };
  }

  const allFiles = parseUnifiedDiff(rawDiff);
  const files = allFiles.filter((f) => !isExcluded(targetPath(f), ctx.config.review.exclude));

  if (files.length === 0) {
    ctx.logger.info(
      `All ${allFiles.length} changed file(s) matched review.exclude — nothing to review.`,
    );
    ctx.out.json({ comments: [], stats: { files: 0, additions: 0, deletions: 0 } });
    return { exitCode: ExitCode.Ok, summary: 'all files excluded' };
  }

  const stats = diffStats(files);
  ctx.logger.info(
    `Reviewing ${stats.files} file(s), +${stats.additions}/-${stats.deletions} with ${ctx.provider.id}:${ctx.provider.model}`,
  );

  const prompt = await ctx.renderTemplate('review', {
    diff: annotateForReview(files),
    extraInstructions: getString(ctx.options, 'instructions') ?? '',
  });

  const comments = await requestComments(ctx, prompt);

  const normalised = normaliseComments(comments, files, ctx.logger.warn.bind(ctx.logger));
  const afterHooks = await ctx.hooks.reviewComments({
    comments: normalised,
    diff: files,
    config: ctx.config,
  });

  const sorted = sortComments(afterHooks);
  const capped = sorted.slice(0, ctx.config.review.maxComments);
  const dropped = sorted.length - capped.length;
  if (dropped > 0) {
    ctx.logger.warn(`${dropped} comment(s) hidden by review.maxComments=${ctx.config.review.maxComments}`);
  }

  render(ctx, capped, stats);

  const failOn = (getString(ctx.options, 'failOn') as FailOn | undefined) ?? ctx.config.review.failOn;
  const blocking = capped.filter((c) => meetsThreshold(c.severity, failOn));

  const summary =
    capped.length === 0
      ? 'no findings'
      : `${capped.length} finding(s), ${blocking.length} at or above "${failOn}"`;

  return {
    exitCode: blocking.length > 0 ? ExitCode.Findings : ExitCode.Ok,
    data: { comments: capped, stats, failOn, blocking: blocking.length },
    summary,
  };
}

async function resolveDiff(
  ctx: CommandContext,
  opts: {
    patchFile?: string | undefined;
    useStdin: boolean;
    staged: boolean;
    base?: string | undefined;
    paths: string[];
  },
): Promise<string> {
  if (opts.patchFile && opts.useStdin) {
    throw new UsageError('Pass either --patch-file or --stdin, not both.');
  }
  if (opts.patchFile) return readTextFile(ctx.cwd, opts.patchFile);
  if (opts.useStdin) {
    const text = await readStdin();
    if (text.trim() === '') {
      throw new UsageError('--stdin was given but nothing was piped in.');
    }
    return text;
  }

  const repo = new GitRepo({ cwd: ctx.cwd });
  await repo.assertRepo();
  const diffOptions: Parameters<GitRepo['diff']>[0] = {};
  if (opts.staged) diffOptions.staged = true;
  if (opts.base) diffOptions.base = opts.base;
  if (opts.paths.length) diffOptions.paths = opts.paths;
  return repo.diff(diffOptions);
}

async function requestComments(ctx: CommandContext, prompt: string): Promise<unknown> {
  const request = {
    system: 'You are a precise, sceptical code reviewer. You report only defects you can see.',
    messages: [{ role: 'user' as const, content: prompt }],
    jsonSchema: { name: 'review', schema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
    signal: ctx.signal,
  };

  try {
    const result = await ctx.complete(request);
    return extractJson(result.text);
  } catch (err) {
    if (!(err instanceof UnsupportedStructuredOutput)) throw err;
    // The model cannot be schema-constrained. Ask again in plain text and
    // recover the JSON, rather than failing a review the user asked for.
    ctx.logger.debug('Provider rejected the response schema; retrying unconstrained.');
    const { jsonSchema: _ignored, ...unconstrained } = request;
    const result = await ctx.complete({
      ...unconstrained,
      messages: [
        {
          role: 'user' as const,
          content: `${prompt}\n\nRespond with a JSON object of the form {"comments": [...]} and nothing else.`,
        },
      ],
    });
    return extractJson(result.text);
  }
}

/**
 * Turns whatever the model returned into comments we are willing to print.
 *
 * Model output is untrusted input. A hallucinated file path or a line number
 * past the end of the diff gets corrected or dropped here, so downstream code
 * and plugin hooks only ever see well-formed comments.
 */
export function normaliseComments(
  raw: unknown,
  files: FileDiff[],
  warn: (message: string) => void = () => {},
): ReviewComment[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { comments?: unknown }).comments)
      ? ((raw as { comments: unknown[] }).comments)
      : undefined;

  if (!list) {
    warn('Model response did not contain a "comments" array; treating as no findings.');
    return [];
  }

  const knownPaths = new Set(files.map(targetPath));
  const changed = changedLineNumbers(files);
  const out: ReviewComment[] = [];

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;

    const message = typeof c.message === 'string' ? c.message.trim() : '';
    if (message === '') continue;

    let file = typeof c.file === 'string' ? c.file.trim() : '';
    if (!knownPaths.has(file)) {
      const matched = [...knownPaths].find((p) => p.endsWith(file) || file.endsWith(p));
      if (matched) {
        file = matched;
      } else if (knownPaths.size === 1) {
        file = [...knownPaths][0] as string;
      } else {
        warn(`Dropping comment for unknown file "${file}": ${message.slice(0, 60)}`);
        continue;
      }
    }

    const rawLine = typeof c.line === 'number' ? Math.trunc(c.line) : 0;
    const lines = changed.get(file);
    let line = rawLine < 0 ? 0 : rawLine;
    if (line > 0 && lines && lines.size > 0 && !lines.has(line)) {
      // Snap to the nearest line this diff actually touched. A comment two
      // lines off is still useful; one pointing at an unrelated line is noise.
      const nearest = [...lines].reduce((best, n) =>
        Math.abs(n - line) < Math.abs(best - line) ? n : best,
      );
      if (Math.abs(nearest - line) > 10) {
        line = 0;
      } else {
        line = nearest;
      }
    }

    const severity: Severity = SEVERITIES.includes(c.severity as Severity)
      ? (c.severity as Severity)
      : 'warning';

    const comment: ReviewComment = {
      file,
      line,
      severity,
      category: typeof c.category === 'string' && c.category.trim() ? c.category.trim() : 'general',
      message,
      // Labelled at the source so a downstream hook cannot be credited with
      // findings that came from the model.
      source: 'review',
    };
    if (typeof c.suggestion === 'string' && c.suggestion.trim() !== '') {
      comment.suggestion = c.suggestion;
    }
    out.push(comment);
  }

  return out;
}

export function sortComments(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
}

export function meetsThreshold(severity: Severity, failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[failOn];
}

function isExcluded(path: string, patterns: string[]): boolean {
  const normalised = path.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    const p = pattern.replace(/\\/g, '/');
    if (p.endsWith('/')) return normalised.startsWith(p) || normalised.includes(`/${p}`);
    if (p.startsWith('*.')) return normalised.endsWith(p.slice(1));
    return normalised === p || normalised.endsWith(`/${p}`);
  });
}

function render(
  ctx: CommandContext,
  comments: ReviewComment[],
  stats: { files: number; additions: number; deletions: number },
): void {
  if (ctx.out.isJson) return;

  if (comments.length === 0) {
    ctx.out.line(ctx.out.green('No findings.'));
    ctx.out.line(
      ctx.out.dim(`Reviewed ${stats.files} file(s), +${stats.additions}/-${stats.deletions}.`),
    );
    return;
  }

  let currentFile = '';
  for (const comment of comments) {
    if (comment.file !== currentFile) {
      currentFile = comment.file;
      ctx.out.line();
      ctx.out.line(ctx.out.bold(currentFile));
    }
    const location = comment.line > 0 ? `:${comment.line}` : '';
    ctx.out.line(
      `  ${paintSeverity(ctx, comment.severity)} ${ctx.out.dim(
        `${currentFile}${location} [${comment.category}]`,
      )}`,
    );
    for (const line of comment.message.split('\n')) {
      ctx.out.line(`      ${line}`);
    }
    if (comment.suggestion) {
      ctx.out.line(ctx.out.dim('      suggestion:'));
      for (const line of comment.suggestion.split('\n')) {
        ctx.out.line(ctx.out.cyan(`      | ${line}`));
      }
    }
  }

  const counts = comments.reduce<Record<Severity, number>>(
    (acc, c) => ({ ...acc, [c.severity]: acc[c.severity] + 1 }),
    { info: 0, warning: 0, error: 0 },
  );
  ctx.out.line();
  ctx.out.line(
    ctx.out.dim(
      `${comments.length} finding(s): ${counts.error} error, ${counts.warning} warning, ${counts.info} info` +
        ` across ${stats.files} file(s), +${stats.additions}/-${stats.deletions}.`,
    ),
  );
}

function paintSeverity(ctx: CommandContext, severity: Severity): string {
  if (severity === 'error') return ctx.out.red('error  ');
  if (severity === 'warning') return ctx.out.yellow('warning');
  return ctx.out.cyan('info   ');
}

export default definePlugin({
  name: 'review',
  apiVersion: PLUGIN_API_VERSION,
  description: 'Reviews a git diff and reports structured comments.',
  commands: [
    {
      name: 'review',
      description: 'Review a diff and report structured comments',
      options: [
        { name: 'staged', description: 'Review staged changes instead of the working tree', type: 'boolean' },
        { name: 'base', description: 'Review changes relative to a ref, e.g. origin/main', type: 'string' },
        { name: 'patch-file', description: 'Review a unified diff read from a file', type: 'string' },
        { name: 'stdin', description: 'Review a unified diff piped on stdin', type: 'boolean' },
        { name: 'path', description: 'Limit the diff to these paths (repeatable)', type: 'string[]' },
        {
          name: 'fail-on',
          description: 'Severity that makes the command exit 5',
          type: 'string',
          choices: [...SEVERITIES, 'never'],
        },
        { name: 'instructions', description: 'Extra review instructions appended to the prompt', type: 'string' },
      ],
      examples: [
        'swai review --staged',
        'swai review --base origin/main --fail-on warning',
        'git diff | swai review --stdin --json',
      ],
      run: runReview,
    },
  ],
});
