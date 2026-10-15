import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/run.js';
import { GitRepo } from '../src/git/repo.js';
import { ExitCode } from '../src/kernel/exit-codes.js';
import { parseUnifiedDiff, targetPath } from '../src/git/diff.js';
import { makeFakeProvider, makeSink, makeTempDir, type TempDir } from './helpers.js';

/**
 * Exercises the real `git` integration end to end.
 *
 * Everything else stubs the provider, but the diff has to come from an actual
 * repository at least once — a hand-written fixture would never catch a change
 * in how git formats its output, which is the failure this guards against.
 */

const dir: TempDir = makeTempDir('swai-git-');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir.path,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/**
 * Set up at module scope, not in `beforeAll`: `describe.runIf` is evaluated
 * during collection, so the flag has to be known before then.
 */
const gitAvailable = ((): boolean => {
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    dir.file('src/app.ts', ['export const a = 1;', 'export const b = 2;', ''].join('\n'));
    git('add', '.');
    git('commit', '-m', 'initial');

    dir.file(
      'src/app.ts',
      ['export const a = 1;', 'export const b = 22;', 'debugger;', ''].join('\n'),
    );
    git('add', '.');
    return true;
  } catch {
    return false;
  }
})();

afterAll(() => dir.cleanup());

async function run(argv: string[], responses: string[] = ['']) {
  const out = makeSink();
  const err = makeSink();
  const code = await runCli({
    argv: ['--no-config', '--cwd', dir.path, '--no-color', ...argv],
    cwd: dir.path,
    env: {},
    stdout: out.write,
    stderr: (line) => err.write(line + '\n'),
    provider: makeFakeProvider({ responses }),
  });
  return { code, stdout: out.text(), stderr: err.text() };
}

describe.runIf(gitAvailable)('git integration', () => {
  it('reads a staged diff that the parser understands', async () => {
    const repo = new GitRepo({ cwd: dir.path });
    expect(await repo.isRepo()).toBe(true);

    const diff = await repo.diff({ staged: true });
    const files = parseUnifiedDiff(diff);

    expect(files.map(targetPath)).toEqual(['src/app.ts']);
    expect(files[0]?.hunks.length).toBeGreaterThan(0);
  });

  it('scopes the diff with a pathspec', async () => {
    const repo = new GitRepo({ cwd: dir.path });
    expect(await repo.diff({ staged: true, paths: ['does/not/exist'] })).toBe('');
  });

  it('reviews the staged diff from a real repository', async () => {
    const { code, stdout } = await run(
      ['review', '--staged', '--json'],
      [JSON.stringify({ comments: [] })],
    );

    // The `debugger;` line is found by review-policy, not by the stubbed model.
    expect(code).toBe(ExitCode.Findings);
    const parsed = JSON.parse(stdout);
    expect(parsed.stats.files).toBe(1);
    expect(parsed.comments[0]).toMatchObject({
      file: 'src/app.ts',
      category: 'debug-leftover',
      source: 'review-policy',
    });
  });

  it('writes a commit message for the staged diff and validates it', async () => {
    const { code, stdout } = await run(['commit-msg'], ['fix(app): correct the value of b']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout.trim()).toBe('fix(app): correct the value of b');
  });

  it('exits 5 when the generated commit message is malformed', async () => {
    const { code, stderr } = await run(['commit-msg'], ['I changed some stuff.']);
    expect(code).toBe(ExitCode.Findings);
    expect(stderr).toContain('does not match');
  });

  it('honours a custom type list', async () => {
    const { code, stderr } = await run(
      ['commit-msg', '--types', 'feat,fix'],
      ['chore: tidy things up'],
    );
    expect(code).toBe(ExitCode.Findings);
    expect(stderr).toContain('unknown type "chore"');
  });

  it('reports a clean working tree as nothing to describe', async () => {
    const { code, stderr } = await run(['commit-msg', '--working-tree'], ['feat: x']);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('No changes in the working tree');
  });

  it('refuses to review outside a repository', async () => {
    const outside = makeTempDir('swai-notgit-');
    try {
      const out = makeSink();
      const err = makeSink();
      const code = await runCli({
        argv: ['--no-config', '--cwd', outside.path, 'review'],
        cwd: outside.path,
        env: {},
        stdout: out.write,
        stderr: (line) => err.write(line + '\n'),
        provider: makeFakeProvider(),
      });
      expect(code).toBe(ExitCode.Usage);
      expect(err.text()).toContain('Not a git repository');
    } finally {
      outside.cleanup();
    }
  });
});
