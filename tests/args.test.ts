import { describe, expect, it } from 'vitest';

import { camelCase, parseCommand, parseGlobals } from '../src/cli/args.js';
import { UsageError } from '../src/kernel/errors.js';
import type { CommandSpec } from '../src/plugins/api.js';

const SPEC: CommandSpec = {
  name: 'demo',
  description: 'demo command',
  args: [
    { name: 'first', description: 'first arg', required: true },
    { name: 'rest', description: 'the rest', variadic: true },
  ],
  options: [
    { name: 'fail-on', description: 'threshold', type: 'string', choices: ['a', 'b'] },
    { name: 'count', short: 'n', description: 'a number', type: 'number' },
    { name: 'verbose', short: 'v', description: 'a flag', type: 'boolean' },
    { name: 'include', description: 'repeatable', type: 'string[]' },
    { name: 'mode', description: 'has a default', type: 'string', default: 'normal' },
  ],
  run: () => ({ exitCode: 0 }),
};

describe('parseGlobals', () => {
  it('extracts global flags from anywhere in argv', () => {
    const { globals, rest } = parseGlobals([
      'review',
      '--json',
      '--provider',
      'openai',
      '--staged',
    ]);
    expect(globals.json).toBe(true);
    expect(globals.provider).toBe('openai');
    expect(rest).toEqual(['review', '--staged']);
  });

  it('supports --flag=value form', () => {
    const { globals } = parseGlobals(['--model=gpt-4o-mini', '--max-tokens=2048']);
    expect(globals.model).toBe('gpt-4o-mini');
    expect(globals.maxTokens).toBe(2048);
  });

  it('collects repeatable plugin flags', () => {
    const { globals } = parseGlobals([
      '--plugin', './a.js',
      '--plugin', './b.js',
      '--disable-plugin', 'review',
    ]);
    expect(globals.plugins).toEqual(['./a.js', './b.js']);
    expect(globals.disablePlugins).toEqual(['review']);
  });

  it('handles --stream and --no-stream', () => {
    expect(parseGlobals(['--no-stream']).globals.stream).toBe(false);
    expect(parseGlobals(['--stream']).globals.stream).toBe(true);
    expect(parseGlobals([]).globals.stream).toBeUndefined();
  });

  it('maps --verbose and --quiet onto log levels', () => {
    expect(parseGlobals(['--verbose']).globals.logLevel).toBe('debug');
    expect(parseGlobals(['--quiet']).globals.logLevel).toBe('error');
  });

  it('stops interpreting flags after --', () => {
    const { globals, rest } = parseGlobals(['explain', '--', '--json']);
    expect(globals.json).toBe(false);
    expect(rest).toEqual(['explain', '--', '--json']);
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseGlobals(['--model'])).toThrow(UsageError);
    expect(() => parseGlobals(['--model', '--json'])).toThrow(/requires a value/);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseGlobals(['--json=yes'])).toThrow(/does not take a value/);
  });

  it('rejects a non-numeric value where a number is required', () => {
    expect(() => parseGlobals(['--max-usd', 'lots'])).toThrow(/expects a number/);
  });
});

describe('parseCommand', () => {
  it('binds positionals, including a variadic tail', () => {
    const { args } = parseCommand(SPEC, ['one', 'two', 'three']);
    expect(args.first).toBe('one');
    expect(args.rest).toEqual(['two', 'three']);
  });

  it('camelCases long option names', () => {
    const { options } = parseCommand(SPEC, ['x', '--fail-on', 'a']);
    expect(options.failOn).toBe('a');
  });

  it('applies declared defaults', () => {
    const { options } = parseCommand(SPEC, ['x']);
    expect(options.mode).toBe('normal');
  });

  it('supports short flags and inline values', () => {
    const { options } = parseCommand(SPEC, ['x', '-v', '-n', '5']);
    expect(options.verbose).toBe(true);
    expect(options.count).toBe(5);

    expect(parseCommand(SPEC, ['x', '--count=7']).options.count).toBe(7);
  });

  it('accumulates repeatable string[] options', () => {
    const { options } = parseCommand(SPEC, ['x', '--include', 'a', '--include', 'b']);
    expect(options.include).toEqual(['a', 'b']);
  });

  it('turns a boolean off with --no-', () => {
    const { options } = parseCommand(SPEC, ['x', '--verbose', '--no-verbose']);
    expect(options.verbose).toBe(false);
  });

  it('accepts a negative number as a value rather than reading it as a flag', () => {
    expect(parseCommand(SPEC, ['x', '--count', '-3']).options.count).toBe(-3);
  });

  it('validates choices', () => {
    expect(() => parseCommand(SPEC, ['x', '--fail-on', 'zzz'])).toThrow(/Expected one of/);
  });

  it('rejects unknown options', () => {
    expect(() => parseCommand(SPEC, ['x', '--nope'])).toThrow(/Unknown option/);
  });

  it('rejects a missing required positional', () => {
    expect(() => parseCommand(SPEC, [])).toThrow(/Missing required argument/);
  });

  it('rejects extra positionals when there is no variadic slot', () => {
    const spec: CommandSpec = {
      name: 'single',
      description: '',
      args: [{ name: 'only', description: '' }],
      run: () => ({ exitCode: 0 }),
    };
    expect(() => parseCommand(spec, ['a', 'b'])).toThrow(/Unexpected argument/);
  });

  it('rejects a missing required option', () => {
    const spec: CommandSpec = {
      name: 'needs',
      description: '',
      options: [{ name: 'must', description: '', type: 'string', required: true }],
      run: () => ({ exitCode: 0 }),
    };
    expect(() => parseCommand(spec, [])).toThrow(/Missing required option/);
  });

  it('rejects a value passed to a boolean flag', () => {
    expect(() => parseCommand(SPEC, ['x', '--verbose=1'])).toThrow(/does not take a value/);
  });

  it('treats everything after -- as positional', () => {
    const { args } = parseCommand(SPEC, ['x', '--', '--not-a-flag']);
    expect(args.rest).toEqual(['--not-a-flag']);
  });

  it('reports a required variadic with nothing supplied', () => {
    const spec: CommandSpec = {
      name: 'v',
      description: '',
      args: [{ name: 'words', description: '', required: true, variadic: true }],
      run: () => ({ exitCode: 0 }),
    };
    expect(() => parseCommand(spec, [])).toThrow(/Missing required argument/);
  });
});

describe('camelCase', () => {
  it('converts kebab-case flag names', () => {
    expect(camelCase('fail-on')).toBe('failOn');
    expect(camelCase('subject-max-length')).toBe('subjectMaxLength');
    expect(camelCase('simple')).toBe('simple');
  });
});
