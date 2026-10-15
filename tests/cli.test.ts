import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/run.js';
import { ExitCode } from '../src/kernel/exit-codes.js';
import { PLUGIN_API_VERSION, type Plugin } from '../src/plugins/api.js';
import { makeFakeProvider, makeSink, makeTempDir, type TempDir } from './helpers.js';

const REVIEW_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@',
  ' const a = 1;',
  '+const b = 2;',
  '+debugger;',
  ' const d = 4;',
  ' const e = 5;',
].join('\n');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe('runCli', () => {
  let dir: TempDir;

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => dir.cleanup());

  async function run(argv: string[], responses: string[] = ['']): Promise<RunResult> {
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

  it('prints help and exits 0 for --help', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('swai <command> [options]');
    expect(stdout).toContain('Exit codes:');
  });

  it('prints help but exits 2 when no command is given', async () => {
    const { code, stdout } = await run([]);
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toContain('Commands:');
  });

  it('prints the version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints per-command help', async () => {
    const { code, stdout } = await run(['review', '--help']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('swai review [options]');
    expect(stdout).toContain('--fail-on');
    expect(stdout).toContain('Examples:');
  });

  it('suggests a near miss for an unknown command', async () => {
    const { code, stderr } = await run(['revieww']);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('unknown command "revieww"');
    expect(stderr).toContain('did you mean "review"?');
  });

  it('lists loaded plugins as JSON', async () => {
    const { code, stdout } = await run(['plugins', '--json']);
    expect(code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(stdout);
    expect(parsed.plugins.map((p: { name: string }) => p.name)).toContain('review-policy');
  });

  it('lists plugins for humans, including hooks with --hooks', async () => {
    const plain = await run(['plugins']);
    expect(plain.code).toBe(ExitCode.Ok);
    expect(plain.stdout).toContain('review-policy');
    expect(plain.stdout).toContain('commands:');
    expect(plain.stdout).not.toContain('hooks:');

    const withHooks = await run(['plugins', '--hooks']);
    expect(withHooks.stdout).toContain('hooks:');
    expect(withHooks.stdout).toContain('reviewComments');
  });

  it('rejects a plugin whose option collides with a reserved global flag', async () => {
    dir.file(
      'clashing-flag.mjs',
      `export default {
         name: 'clashy',
         apiVersion: ${PLUGIN_API_VERSION},
         commands: [{
           name: 'clashy',
           description: 'x',
           options: [{ name: 'verbose', description: 'never reachable', type: 'boolean' }],
           run: () => ({ exitCode: 0 }),
         }],
       };`,
    );
    const { code, stderr } = await run(['--plugin', './clashing-flag.mjs', 'plugins']);
    expect(code).toBe(ExitCode.PluginError);
    expect(stderr).toContain('reserved global flag');
  });

  it('shows a pricing override in the price table', async () => {
    dir.file('swai.config.json', JSON.stringify({ pricing: { 'my-model': { input: 1, output: 2 } } }));
    const out = makeSink();
    const code = await runCli({
      argv: ['--cwd', dir.path, '--no-color', 'price'],
      cwd: dir.path,
      env: {},
      stdout: out.write,
      stderr: () => {},
      provider: makeFakeProvider(),
    });
    expect(code).toBe(ExitCode.Ok);
    expect(out.text()).toContain('my-model');
    expect(out.text()).toContain('overridden by "pricing"');
  });

  it('prints the effective price table', async () => {
    const { code, stdout } = await run(['price']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('gpt-4o');
  });

  describe('review', () => {
    beforeEach(() => {
      dir.file('change.diff', REVIEW_DIFF);
    });

    it('exits 0 when the model reports nothing and no policy rule fires', async () => {
      dir.file('clean.diff', REVIEW_DIFF.replace('+debugger;', '+const c = 3;'));
      const { code, stdout } = await run(
        ['review', '--patch-file', 'clean.diff'],
        [JSON.stringify({ comments: [] })],
      );
      expect(code).toBe(ExitCode.Ok);
      expect(stdout).toContain('No findings.');
    });

    it('exits 5 when a finding meets the failure threshold', async () => {
      const response = JSON.stringify({
        comments: [
          {
            file: 'src/app.ts',
            line: 2,
            severity: 'error',
            category: 'correctness',
            message: 'b is never used',
            suggestion: null,
          },
        ],
      });
      const { code, stdout } = await run(['review', '--patch-file', 'change.diff'], [response]);
      expect(code).toBe(ExitCode.Findings);
      expect(stdout).toContain('b is never used');
    });

    it('respects --fail-on never', async () => {
      const response = JSON.stringify({
        comments: [
          { file: 'src/app.ts', line: 2, severity: 'error', category: 'x', message: 'bad', suggestion: null },
        ],
      });
      const { code } = await run(
        ['review', '--patch-file', 'change.diff', '--fail-on', 'never'],
        [response],
      );
      expect(code).toBe(ExitCode.Ok);
    });

    it('adds review-policy findings even when the model reports nothing', async () => {
      const { code, stdout } = await run(
        ['review', '--patch-file', 'change.diff'],
        [JSON.stringify({ comments: [] })],
      );
      // The `debugger;` line is caught by a deterministic rule, not the model.
      expect(code).toBe(ExitCode.Findings);
      expect(stdout).toContain('debugger');
    });

    it('emits machine-readable output with --json', async () => {
      const { code, stdout } = await run(
        ['review', '--patch-file', 'change.diff', '--json'],
        [JSON.stringify({ comments: [] })],
      );
      expect(code).toBe(ExitCode.Findings);
      const parsed = JSON.parse(stdout);
      expect(parsed.command).toBe('review');
      expect(parsed.stats).toEqual({ files: 1, additions: 2, deletions: 0 });
      expect(parsed.comments[0].category).toBe('debug-leftover');
      expect(parsed.usage.calls).toBe(1);
    });

    it('recovers JSON from a response wrapped in prose', async () => {
      const messy = 'Sure! Here is the review:\n```json\n{"comments": []}\n```\nHope that helps.';
      const { code } = await run(
        ['review', '--patch-file', 'change.diff', '--fail-on', 'never'],
        [messy],
      );
      expect(code).toBe(ExitCode.Ok);
    });

    it('reports an empty diff as nothing to review', async () => {
      dir.file('empty.diff', '');
      const { code, stderr } = await run(['review', '--patch-file', 'empty.diff']);
      expect(code).toBe(ExitCode.Ok);
      expect(stderr).toContain('No changes to review');
    });

    it('excludes lockfiles by default', async () => {
      dir.file(
        'lock.diff',
        [
          'diff --git a/package-lock.json b/package-lock.json',
          '--- a/package-lock.json',
          '+++ b/package-lock.json',
          '@@ -1,1 +1,2 @@',
          ' {',
          '+  "x": 1',
        ].join('\n'),
      );
      const { code, stderr } = await run(['review', '--patch-file', 'lock.diff']);
      expect(code).toBe(ExitCode.Ok);
      expect(stderr).toContain('matched review.exclude');
    });

    it('rejects --patch-file together with --stdin', async () => {
      const { code, stderr } = await run(['review', '--patch-file', 'change.diff', '--stdin']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('not both');
    });

    it('exits 3 when the patch file does not exist', async () => {
      const { code, stderr } = await run(['review', '--patch-file', 'missing.diff']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('File not found');
    });
  });

  describe('generate', () => {
    it('writes the generated code to --output', async () => {
      const { code } = await run(
        ['generate', 'a', 'greeting', 'function', '-o', 'out.ts'],
        ['export const hi = () => "hi";'],
      );
      expect(code).toBe(ExitCode.Ok);
      expect(readFileSync(join(dir.path, 'out.ts'), 'utf8')).toBe(
        'export const hi = () => "hi";\n',
      );
    });

    it('strips a code fence the model added anyway', async () => {
      await run(['generate', 'x', '-o', 'out.ts'], ['```ts\nconst a = 1;\n```']);
      expect(readFileSync(join(dir.path, 'out.ts'), 'utf8')).toBe('const a = 1;\n');
    });

    it('requires a request', async () => {
      const { code, stderr } = await run(['generate']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('Missing required argument');
    });

    it('previews a patch without touching disk, then applies it on --apply', async () => {
      dir.file('src/app.ts', ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'));
      const patch = [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 22;',
        ' const c = 3;',
      ].join('\n');

      const preview = await run(
        ['generate', '--patch', '-c', 'src/app.ts', 'bump b'],
        [patch],
      );
      expect(preview.code).toBe(ExitCode.Ok);
      expect(preview.stdout).toContain('would modify src/app.ts');
      expect(readFileSync(join(dir.path, 'src/app.ts'), 'utf8')).toContain('const b = 2;');

      const applied = await run(
        ['generate', '--apply', '-c', 'src/app.ts', 'bump b'],
        [patch],
      );
      expect(applied.code).toBe(ExitCode.Ok);
      expect(applied.stdout).toContain('modify src/app.ts');
      expect(readFileSync(join(dir.path, 'src/app.ts'), 'utf8')).toContain('const b = 22;');
    });

    it('exits 6 when the model returns something that is not a diff', async () => {
      dir.file('src/app.ts', 'const a = 1;\n');
      const { code, stderr } = await run(
        ['generate', '--patch', '-c', 'src/app.ts', 'do a thing'],
        ['I am afraid I cannot do that.'],
      );
      expect(code).toBe(ExitCode.PatchFailed);
      expect(stderr).toContain('did not return a parseable unified diff');
    });

    it('exits 6 when a hunk does not apply', async () => {
      dir.file('src/app.ts', 'totally different content\n');
      const patch = [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 22;',
        ' const c = 3;',
      ].join('\n');

      const { code, stdout } = await run(
        ['generate', '--apply', '-c', 'src/app.ts', 'x'],
        [patch],
      );
      expect(code).toBe(ExitCode.PatchFailed);
      expect(stdout).toContain('rejected hunk');
    });

    it('rejects --apply together with --dry-run', async () => {
      const { code, stderr } = await run(['generate', '--apply', '--dry-run', 'x']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('mutually exclusive');
    });

    it('requires context files in patch mode', async () => {
      const { code, stderr } = await run(['generate', '--patch', 'x']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('at least one --context file');
    });
  });

  describe('explain', () => {
    it('explains a file', async () => {
      dir.file('thing.ts', 'export const add = (a: number, b: number) => a + b;\n');
      const { code, stdout } = await run(['explain', 'thing.ts'], ['It adds two numbers.']);
      expect(code).toBe(ExitCode.Ok);
      expect(stdout).toContain('It adds two numbers.');
    });

    it('honours --lines', async () => {
      dir.file('thing.ts', ['one', 'two', 'three', 'four'].join('\n'));
      const { code } = await run(['explain', 'thing.ts', '--lines', '2:3'], ['ok']);
      expect(code).toBe(ExitCode.Ok);
    });

    it('rejects an out-of-range --lines', async () => {
      dir.file('thing.ts', 'one\n');
      const { code, stderr } = await run(['explain', 'thing.ts', '--lines', '50:60'], ['ok']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('past the end');
    });

    it('rejects a --detail value outside the allowed set', async () => {
      dir.file('thing.ts', 'one\n');
      const { code, stderr } = await run(['explain', 'thing.ts', '--detail', 'exhaustive']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('Expected one of');
    });
  });

  describe('plugin system', () => {
    it('turning off a built-in removes its command, proving they are ordinary plugins', async () => {
      const { code, stderr } = await run(['--disable-plugin', 'review', 'review']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('unknown command "review"');
    });

    it('loads a third-party plugin from disk and runs its command', async () => {
      dir.file(
        'my-plugin.mjs',
        `export default {
           name: 'greeter',
           apiVersion: ${PLUGIN_API_VERSION},
           commands: [{
             name: 'greet',
             description: 'greets',
             args: [{ name: 'who', description: 'who to greet' }],
             run: (ctx) => {
               ctx.out.line('hello ' + (ctx.args.who ?? 'world'));
               return { exitCode: 0, data: { greeted: ctx.args.who ?? 'world' } };
             },
           }],
         };`,
      );

      const { code, stdout } = await run(['--plugin', './my-plugin.mjs', 'greet', 'reviewer']);
      expect(code).toBe(ExitCode.Ok);
      expect(stdout).toContain('hello reviewer');
    });

    it('exits 8 when a plugin cannot be loaded', async () => {
      const { code, stderr } = await run(['--plugin', './missing.mjs', 'plugins']);
      expect(code).toBe(ExitCode.PluginError);
      expect(stderr).toContain('Could not load plugin');
    });

    it('lets a plugin hook filter review findings', async () => {
      dir.file('change.diff', REVIEW_DIFF);
      dir.file(
        'silencer.mjs',
        `export default {
           name: 'silencer',
           apiVersion: ${PLUGIN_API_VERSION},
           hooks: { reviewComments: () => [] },
         };`,
      );

      const { code, stdout } = await run(
        ['--plugin', './silencer.mjs', 'review', '--patch-file', 'change.diff'],
        [JSON.stringify({ comments: [] })],
      );
      // The debugger finding would otherwise make this exit 5.
      expect(code).toBe(ExitCode.Ok);
      expect(stdout).toContain('No findings.');
    });
  });

  describe('budget and errors', () => {
    it('exits 7 when the token budget is exceeded', async () => {
      dir.file('thing.ts', 'const a = 1;\n');
      const { code, stderr } = await run(['explain', 'thing.ts', '--token-budget', '1'], ['x']);
      expect(code).toBe(ExitCode.BudgetExceeded);
      expect(stderr).toContain('Token budget exceeded');
    });

    it('exits 2 for an invalid global flag value', async () => {
      const { code, stderr } = await run(['--log-level', 'loud', 'plugins']);
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toContain('Unknown --log-level');
    });

    it('exits 3 when the named config file is missing', async () => {
      const out = makeSink();
      const err = makeSink();
      const code = await runCli({
        argv: ['--config', 'nope.json', 'plugins'],
        cwd: dir.path,
        env: {},
        stdout: out.write,
        stderr: (line) => err.write(line + '\n'),
        provider: makeFakeProvider(),
      });
      expect(code).toBe(ExitCode.Config);
      expect(err.text()).toContain('Config file not found');
    });

    it('prints a hint alongside the error when one is available', async () => {
      const { stderr } = await run(['generate', '--patch', 'x']);
      expect(stderr).toContain('hint:');
    });
  });

  it('reads settings from a config file', async () => {
    dir.file('change.diff', REVIEW_DIFF);
    dir.file(
      'swai.config.json',
      JSON.stringify({
        review: { failOn: 'never' },
        pluginConfig: { 'review-policy': { builtinPatterns: false } },
      }),
    );

    const out = makeSink();
    const err = makeSink();
    const code = await runCli({
      argv: ['--cwd', dir.path, '--no-color', 'review', '--patch-file', 'change.diff'],
      cwd: dir.path,
      env: {},
      stdout: out.write,
      stderr: (line) => err.write(line + '\n'),
      provider: makeFakeProvider({ responses: [JSON.stringify({ comments: [] })] }),
    });

    expect(code).toBe(ExitCode.Ok);
    expect(out.text()).toContain('No findings.');
  });

  it('reports token and cost usage on stderr after a model call', async () => {
    dir.file('thing.ts', 'const a = 1;\n');
    const { stderr } = await run(['explain', 'thing.ts'], ['fine']);
    expect(stderr).toMatch(/1 call · 100 in · 50 out · \$/);
  });
});

describe('runCli plugin conflicts', () => {
  it('exits 8 when two plugins claim the same command', async () => {
    const dir = makeTempDir();
    try {
      dir.file(
        'clash.mjs',
        `export default {
           name: 'clash',
           apiVersion: ${PLUGIN_API_VERSION},
           commands: [{ name: 'review', description: 'clashing', run: () => ({ exitCode: 0 }) }],
         };`,
      );
      const err = makeSink();
      const code = await runCli({
        argv: ['--no-config', '--cwd', dir.path, '--plugin', './clash.mjs', 'plugins'],
        cwd: dir.path,
        env: {},
        stdout: () => {},
        stderr: (line) => err.write(line + '\n'),
        provider: makeFakeProvider(),
      });
      expect(code).toBe(ExitCode.PluginError);
      expect(err.text()).toContain('already registered by plugin "review"');
    } finally {
      dir.cleanup();
    }
  });
});

const _typeCheck: Plugin | undefined = undefined;
void _typeCheck;
