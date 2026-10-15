import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { extractJson } from '../src/kernel/json.js';
import { createRenderer } from '../src/output/renderer.js';
import { createLogger, isLogLevel, silentLogger } from '../src/kernel/logger.js';
import { TemplateLoader, renderTemplate, PACKAGED_TEMPLATES_DIR } from '../src/prompts/templates.js';
import { GitRepo } from '../src/git/repo.js';
import { languageFor, readContextFiles, readTextFile } from '../src/kernel/input.js';
import { ExitCode, exitCodeName } from '../src/kernel/exit-codes.js';
import { CliError, ConfigError, UsageError, toCliError } from '../src/kernel/errors.js';
import { formatCommandHelp, formatRootHelp } from '../src/cli/help.js';
import { closestMatch, readVersion } from '../src/cli/run.js';
import {
  getBoolean,
  getNumber,
  getString,
  getStringArray,
  definePlugin,
  PLUGIN_API_VERSION,
} from '../src/plugins/api.js';
import * as publicApi from '../src/index.js';
import { makeSink, makeTempDir } from './helpers.js';

describe('extractJson', () => {
  it('parses a bare JSON document', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });

  it('unwraps a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('finds a document embedded in prose', () => {
    expect(extractJson('Sure!\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJson('prose {"a":"}{ not the end"} more prose')).toEqual({
      a: '}{ not the end',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('x {"a":"say \\"hi\\""} y')).toEqual({ a: 'say "hi"' });
  });

  it('throws rather than guessing when there is no JSON', () => {
    expect(() => extractJson('no json at all')).toThrow(/No JSON object or array found/);
  });

  it('throws rather than repairing a truncated document', () => {
    expect(() => extractJson('prefix {"a": 1, "b":')).toThrow(/No JSON object or array found/);
  });

  it('reports a balanced but invalid span distinctly', () => {
    expect(() => extractJson('note {a: 1} end')).toThrow(/could not parse it/);
  });
});

describe('createRenderer', () => {
  it('writes text and lines in human mode', () => {
    const sink = makeSink();
    const out = createRenderer({ write: sink.write, color: false });
    out.text('partial');
    out.line(' done');
    expect(sink.text()).toBe('partial done\n');
    expect(out.captured()).toBe('partial done\n');
  });

  it('suppresses human output and emits one document in JSON mode', () => {
    const sink = makeSink();
    const out = createRenderer({ json: true, write: sink.write });
    out.text('ignored');
    out.line('ignored');
    out.json({ ok: true });
    expect(JSON.parse(sink.text())).toEqual({ ok: true });
  });

  it('emits nothing from json() in human mode', () => {
    const sink = makeSink();
    createRenderer({ write: sink.write, color: false }).json({ ok: true });
    expect(sink.text()).toBe('');
  });

  it('applies colour only when enabled', () => {
    const plain = createRenderer({ write: () => {}, color: false });
    expect(plain.red('x')).toBe('x');

    const coloured = createRenderer({ write: () => {}, color: true });
    expect(coloured.red('x')).not.toBe('x');
    expect(coloured.red('x')).toContain('x');
    for (const paint of [coloured.bold, coloured.dim, coloured.green, coloured.yellow, coloured.cyan]) {
      expect(paint('x')).toContain('x');
    }
  });
});

describe('createLogger', () => {
  it('respects the level threshold', () => {
    // `write` receives one call per line, without the terminator.
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines).toEqual(['warn: w', 'error: e']);
  });

  it('prefixes child loggers', () => {
    const lines: string[] = [];
    createLogger({ level: 'info', write: (line) => lines.push(line) })
      .child('myplugin')
      .info('hello');
    expect(lines).toEqual(['info: [myplugin] hello']);
  });

  it('formats extra arguments, including errors and objects', () => {
    const sink = makeSink();
    const logger = createLogger({ level: 'info', write: sink.write });
    logger.info('obj', { a: 1 });
    logger.info('err', new Error('boom'));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.info('circular', circular);

    expect(sink.text()).toContain('{"a":1}');
    expect(sink.text()).toContain('boom');
    expect(sink.text()).toContain('[object Object]');
  });

  it('silences everything at level silent', () => {
    const sink = makeSink();
    const logger = createLogger({ level: 'silent', write: sink.write });
    logger.error('nope');
    expect(sink.text()).toBe('');
    expect(silentLogger.level).toBe('silent');
  });

  it('validates log level names', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('loud')).toBe(false);
    expect(isLogLevel(3)).toBe(false);
  });
});

describe('templates', () => {
  it('renders the packaged templates', async () => {
    const loader = new TemplateLoader();
    const rendered = await loader.render('review', {
      diff: 'THE DIFF',
      extraInstructions: '',
    });
    expect(rendered).toContain('THE DIFF');
    expect(rendered).not.toContain('{{');
  });

  it('caches a template after the first read', async () => {
    const loader = new TemplateLoader();
    const first = await loader.read('explain');
    expect(await loader.read('explain')).toBe(first);
  });

  it('prefers a template from templatesDir over the packaged one', async () => {
    const dir = makeTempDir();
    try {
      dir.file('review.md', 'CUSTOM {{diff}}');
      const loader = new TemplateLoader({ templatesDir: dir.path });
      expect(await loader.render('review', { diff: 'X' })).toBe('CUSTOM X');
      // A template not overridden still falls back to the packaged copy.
      expect(await loader.read('explain')).toContain('Explain the code below');
    } finally {
      dir.cleanup();
    }
  });

  it('reports a missing template with the directories searched', async () => {
    await expect(new TemplateLoader().read('does-not-exist')).rejects.toThrow(ConfigError);
    expect(PACKAGED_TEMPLATES_DIR).toContain('templates');
  });

  it('throws on an unfilled placeholder rather than silently emitting nothing', () => {
    expect(() => renderTemplate('a {{one}} b {{two}}', { one: '1' }, 'demo')).toThrow(
      /unfilled placeholders: two/,
    );
  });

  it('tolerates whitespace inside a placeholder', () => {
    expect(renderTemplate('{{ name }}', { name: 'x' })).toBe('x');
  });
});

describe('GitRepo', () => {
  it('detects a repository', async () => {
    const repo = new GitRepo({
      cwd: '/anywhere',
      exec: async () => ({ stdout: 'true\n', stderr: '' }),
    });
    expect(await repo.isRepo()).toBe(true);
    await expect(repo.assertRepo()).resolves.toBeUndefined();
  });

  it('reports a non-repository, and assertRepo explains what to do', async () => {
    const repo = new GitRepo({
      cwd: '/anywhere',
      exec: async () => {
        throw new Error('not a git repository');
      },
    });
    expect(await repo.isRepo()).toBe(false);
    await expect(repo.assertRepo()).rejects.toThrow(UsageError);
    // The way out is carried as a hint, not buried in the message.
    await expect(repo.assertRepo()).rejects.toMatchObject({
      hint: expect.stringContaining('--patch-file'),
    });
  });

  it('builds diff arguments that cannot be broken by user git config', async () => {
    const seen: string[][] = [];
    const repo = new GitRepo({
      cwd: '/anywhere',
      exec: async (args) => {
        seen.push(args);
        return { stdout: '', stderr: '' };
      },
    });

    await repo.diff();
    await repo.diff({ staged: true, base: 'origin/main', paths: ['src', 'tests'] });

    // --no-color and --no-ext-diff stop a user's config producing something
    // the parser silently reads as "no changes".
    expect(seen[0]).toEqual(['diff', '--no-color', '--no-ext-diff', '--unified=3']);
    expect(seen[1]).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--unified=3',
      '--cached',
      'origin/main...',
      '--',
      'src',
      'tests',
    ]);
  });

  it('returns the repository root', async () => {
    const repo = new GitRepo({
      cwd: '/anywhere',
      exec: async () => ({ stdout: '/repo/root\n', stderr: '' }),
    });
    expect(await repo.root()).toBe('/repo/root');
  });
});

describe('input helpers', () => {
  it('maps extensions onto language tags', () => {
    expect(languageFor('a.ts')).toBe('typescript');
    expect(languageFor('a.PY')).toBe('python');
    expect(languageFor('a.unknown')).toBe('');
  });

  it('reads a text file and rejects a missing one', async () => {
    const dir = makeTempDir();
    try {
      dir.file('a.txt', 'hello');
      expect(await readTextFile(dir.path, 'a.txt')).toBe('hello');
      await expect(readTextFile(dir.path, 'nope.txt')).rejects.toThrow(UsageError);
    } finally {
      dir.cleanup();
    }
  });

  it('labels context files and announces truncation instead of hiding it', async () => {
    const dir = makeTempDir();
    try {
      dir.file('a.ts', 'const a = 1;');
      dir.file('big.ts', 'x'.repeat(500));

      expect(await readContextFiles(dir.path, [])).toBe('');

      const block = await readContextFiles(dir.path, ['a.ts']);
      expect(block).toContain('--- a.ts ---');
      expect(block).toContain('```typescript');

      const truncated = await readContextFiles(dir.path, ['big.ts'], 100);
      expect(truncated).toContain('[truncated: big.ts is 500 bytes, showing the first 100]');
    } finally {
      dir.cleanup();
    }
  });
});

describe('errors and exit codes', () => {
  it('names exit codes, including unknown ones', () => {
    expect(exitCodeName(ExitCode.Findings)).toBe('Findings');
    expect(exitCodeName(99)).toBe('Unknown(99)');
  });

  it('carries an exit code and an optional hint', () => {
    const err = new UsageError('bad', { hint: 'try this' });
    expect(err.exitCode).toBe(ExitCode.Usage);
    expect(err.hint).toBe('try this');
    expect(new CliError('x').exitCode).toBe(ExitCode.Error);
  });

  it('wraps arbitrary throws, preserving CliErrors as they are', () => {
    const original = new UsageError('keep me');
    expect(toCliError(original)).toBe(original);
    expect(toCliError(new Error('plain')).message).toBe('plain');
    expect(toCliError('a string').message).toBe('a string');
    expect(toCliError(new Error('plain')).exitCode).toBe(ExitCode.Error);
  });
});

describe('help formatting', () => {
  const command = {
    name: 'demo',
    description: 'a demo command',
    args: [
      { name: 'first', description: 'the first', required: true },
      { name: 'rest', description: 'the rest', variadic: true },
    ],
    options: [
      { name: 'flag', short: 'f', description: 'a flag', type: 'boolean' as const },
      { name: 'pick', description: 'a choice', type: 'string' as const, choices: ['a', 'b'] },
      { name: 'many', description: 'repeatable', type: 'string[]' as const },
      { name: 'num', description: 'a number', type: 'number' as const, default: 3 },
    ],
    examples: ['swai demo x'],
    run: () => ({ exitCode: ExitCode.Ok }),
  };

  it('renders command usage, arguments, options and examples', () => {
    const help = formatCommandHelp(command);
    expect(help).toContain('swai demo <first> [rest...] [options]');
    expect(help).toContain('-f, --flag');
    expect(help).toContain('one of: a, b');
    expect(help).toContain('default: 3');
    expect(help).toContain('--many <value...>');
    expect(help).toContain('swai demo x');
  });

  it('renders a command with no arguments or options', () => {
    const help = formatCommandHelp({ name: 'bare', description: 'nothing', run: () => ({ exitCode: 0 }) });
    expect(help).toContain('swai bare [options]');
    expect(help).not.toContain('Arguments:');
  });

  it('renders the root help with commands and exit codes', () => {
    const help = formatRootHelp([command], '1.2.3');
    expect(help).toContain('swai 1.2.3');
    expect(help).toContain('demo');
    expect(help).toContain('review findings at or above --fail-on');
  });
});

describe('closestMatch', () => {
  it('suggests a near miss but stays quiet on a wild one', () => {
    expect(closestMatch('revieww', ['review', 'generate'])).toBe('review');
    expect(closestMatch('xyzzy', ['review', 'generate'])).toBeUndefined();
    expect(closestMatch('rev', [])).toBeUndefined();
  });
});

describe('option accessors', () => {
  const options = {
    str: 'value',
    flag: true,
    num: 42,
    numText: '7',
    list: ['a', 'b'],
    single: 'solo',
    junk: { nope: true },
  };

  it('reads strings, booleans, numbers and arrays defensively', () => {
    expect(getString(options, 'str')).toBe('value');
    expect(getString(options, 'num')).toBeUndefined();
    expect(getString(options, 'missing')).toBeUndefined();

    expect(getBoolean(options, 'flag')).toBe(true);
    expect(getBoolean(options, 'missing')).toBe(false);

    expect(getNumber(options, 'num')).toBe(42);
    expect(getNumber(options, 'numText')).toBe(7);
    expect(getNumber(options, 'str')).toBeUndefined();
    expect(getNumber(options, 'missing')).toBeUndefined();

    expect(getStringArray(options, 'list')).toEqual(['a', 'b']);
    expect(getStringArray(options, 'single')).toEqual(['solo']);
    expect(getStringArray(options, 'junk')).toEqual([]);
  });
});

describe('public API surface', () => {
  it('re-exports the kernel, plugin API and helpers used by plugin authors', () => {
    expect(typeof publicApi.runCli).toBe('function');
    expect(typeof publicApi.Kernel).toBe('function');
    expect(typeof publicApi.definePlugin).toBe('function');
    expect(publicApi.PLUGIN_API_VERSION).toBe(PLUGIN_API_VERSION);
    expect(publicApi.ExitCode.Findings).toBe(5);
    expect(publicApi.BUILTIN_PLUGINS.length).toBeGreaterThan(0);
    expect(typeof publicApi.parseUnifiedDiff).toBe('function');
    expect(typeof publicApi.applyPatch).toBe('function');
    expect(typeof publicApi.computeCost).toBe('function');
    expect(publicApi.readVersion()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('definePlugin is an identity helper that only adds type-checking', () => {
    const plugin = { name: 'x', apiVersion: PLUGIN_API_VERSION };
    expect(definePlugin(plugin)).toBe(plugin);
  });
});

describe('readVersion', () => {
  it('reads the version from package.json', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('PACKAGED_TEMPLATES_DIR', () => {
  it('points at a directory containing the shipped templates', async () => {
    const loader = new TemplateLoader();
    for (const name of ['review', 'generate', 'generate-patch', 'explain', 'commit-message']) {
      await expect(loader.read(name)).resolves.toContain('');
    }
    expect(join(PACKAGED_TEMPLATES_DIR, 'review.md')).toBeTruthy();
  });
});
