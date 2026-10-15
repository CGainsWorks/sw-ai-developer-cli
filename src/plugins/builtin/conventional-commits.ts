/**
 * Reference plugin #1 — contributes a command.
 *
 * Everything here is written against the public `../api.js` surface, exactly as
 * an out-of-tree plugin would be. Nothing in it reaches into the kernel.
 *
 * Config (`pluginConfig["conventional-commits"]`):
 *   {
 *     "types": ["feat", "fix", ...],
 *     "subjectMaxLength": 72,
 *     "signOff": false
 *   }
 */

import { ExitCode } from '../../kernel/exit-codes.js';
import { UsageError } from '../../kernel/errors.js';
import { GitRepo } from '../../git/repo.js';
import {
  definePlugin,
  getBoolean,
  getNumber,
  getString,
  PLUGIN_API_VERSION,
  type CommandContext,
  type CommandResult,
} from '../api.js';

export const PLUGIN_NAME = 'conventional-commits';

export const DEFAULT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

export const DEFAULT_SUBJECT_MAX_LENGTH = 72;

interface Settings {
  types?: string[];
  subjectMaxLength?: number;
  signOff?: boolean;
}

export async function runCommitMessage(ctx: CommandContext): Promise<CommandResult> {
  const settings = ctx.pluginConfig<Settings>(PLUGIN_NAME) ?? {};

  const repo = new GitRepo({ cwd: ctx.cwd });
  await repo.assertRepo();

  // Default to the index: a commit message describes what is about to be
  // committed, not whatever else is lying around in the working tree.
  const useWorkingTree = getBoolean(ctx.options, 'workingTree');
  const diff = await repo.diff({ staged: !useWorkingTree });

  if (diff.trim() === '') {
    throw new UsageError(
      useWorkingTree ? 'No changes in the working tree.' : 'Nothing staged.',
      { hint: useWorkingTree ? undefined : 'Stage something with `git add`, or pass --working-tree.' },
    );
  }

  const types = parseTypes(getString(ctx.options, 'types')) ?? settings.types ?? DEFAULT_TYPES;
  const subjectMaxLength =
    getNumber(ctx.options, 'subjectMaxLength') ??
    settings.subjectMaxLength ??
    DEFAULT_SUBJECT_MAX_LENGTH;

  const prompt = await ctx.renderTemplate('commit-message', {
    diff,
    types: types.join(', '),
    subjectMaxLength: String(subjectMaxLength),
  });

  const result = await ctx.complete({
    system: 'You write precise Conventional Commits messages. You output the message only.',
    messages: [{ role: 'user', content: prompt }],
    signal: ctx.signal,
  });

  let message = cleanMessage(result.text);
  if (settings.signOff) {
    message += `\n\nSigned-off-by: ${await gitIdentity(repo)}`;
  }

  const validation = validateMessage(message, { types, subjectMaxLength });
  for (const problem of validation.problems) {
    ctx.logger.warn(`generated message: ${problem}`);
  }

  ctx.out.line(message);

  return {
    exitCode: validation.valid ? ExitCode.Ok : ExitCode.Findings,
    data: { message, valid: validation.valid, problems: validation.problems },
    summary: validation.valid
      ? 'generated a valid Conventional Commits message'
      : `generated a message with ${validation.problems.length} problem(s)`,
  };
}

async function gitIdentity(repo: GitRepo): Promise<string> {
  // Best-effort: an unset identity is not worth failing the command over.
  try {
    const root = await repo.root();
    void root;
  } catch {
    /* ignore */
  }
  return `${process.env.GIT_AUTHOR_NAME ?? ''} <${process.env.GIT_AUTHOR_EMAIL ?? ''}>`.trim();
}

function parseTypes(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const types = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return types.length > 0 ? types : undefined;
}

/** Removes a code fence and any leading blank lines the model added. */
export function cleanMessage(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fence?.[1] ?? trimmed).trim();
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

const HEADER = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/;

export function validateMessage(
  message: string,
  options: { types: string[]; subjectMaxLength: number },
): ValidationResult {
  const problems: string[] = [];
  const lines = message.split('\n');
  const header = lines[0] ?? '';

  const match = HEADER.exec(header);
  if (!match) {
    problems.push(`header does not match "<type>(<scope>): <subject>": ${JSON.stringify(header)}`);
    return { valid: false, problems };
  }

  const [, type, , , subject] = match;
  if (type && !options.types.includes(type)) {
    problems.push(`unknown type "${type}" (allowed: ${options.types.join(', ')})`);
  }
  if (subject && subject.length > options.subjectMaxLength) {
    problems.push(
      `subject is ${subject.length} characters, limit is ${options.subjectMaxLength}`,
    );
  }
  if (subject && /\.$/.test(subject)) {
    problems.push('subject ends with a full stop');
  }
  if (subject && /^[A-Z][a-z]/.test(subject)) {
    problems.push('subject starts with a capital letter');
  }
  if (lines.length > 1 && lines[1] !== '') {
    problems.push('the line after the header must be blank');
  }

  return { valid: problems.length === 0, problems };
}

export default definePlugin({
  name: PLUGIN_NAME,
  apiVersion: PLUGIN_API_VERSION,
  version: '1.0.0',
  description: 'Adds `commit-msg`, which writes a Conventional Commits message for the staged diff.',
  commands: [
    {
      name: 'commit-msg',
      description: 'Write a Conventional Commits message for the staged diff',
      options: [
        {
          name: 'working-tree',
          description: 'Use the working tree instead of the index',
          type: 'boolean',
        },
        { name: 'types', description: 'Comma-separated list of allowed types', type: 'string' },
        {
          name: 'subject-max-length',
          description: 'Maximum subject length',
          type: 'number',
        },
      ],
      examples: ['git add -p && swai commit-msg', 'swai commit-msg --types feat,fix --json'],
      run: runCommitMessage,
    },
  ],
});
