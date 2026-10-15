import { describe, expect, it, vi } from 'vitest';

import { meetsThreshold, normaliseComments, sortComments } from '../src/commands/review.js';
import { sliceLines } from '../src/commands/explain.js';
import { stripCodeFence } from '../src/commands/generate.js';
import { parseUnifiedDiff } from '../src/git/diff.js';
import { UsageError } from '../src/kernel/errors.js';
import type { ReviewComment } from '../src/plugins/api.js';

const DIFF = parseUnifiedDiff(
  [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,5 @@',
    ' const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    ' const d = 4;',
    ' const e = 5;',
  ].join('\n'),
);

describe('normaliseComments', () => {
  it('accepts a well-formed comments array', () => {
    const out = normaliseComments(
      {
        comments: [
          {
            file: 'src/app.ts',
            line: 2,
            severity: 'error',
            category: 'correctness',
            message: 'bad',
            suggestion: 'good',
          },
        ],
      },
      DIFF,
    );
    expect(out).toEqual([
      {
        file: 'src/app.ts',
        line: 2,
        severity: 'error',
        category: 'correctness',
        message: 'bad',
        suggestion: 'good',
        // Labelled at the source so a later hook is not credited with it.
        source: 'review',
      },
    ]);
  });

  it('accepts a bare array as well as a wrapped object', () => {
    const out = normaliseComments(
      [{ file: 'src/app.ts', line: 2, severity: 'info', category: 'x', message: 'hi' }],
      DIFF,
    );
    expect(out).toHaveLength(1);
  });

  it('returns nothing, and warns, when the response has no comments array', () => {
    const warn = vi.fn();
    expect(normaliseComments({ nonsense: true }, DIFF, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not contain a "comments" array'));
  });

  it('drops entries with no message', () => {
    const out = normaliseComments(
      { comments: [{ file: 'src/app.ts', line: 2, message: '   ' }, null, 'nope'] },
      DIFF,
    );
    expect(out).toEqual([]);
  });

  it('repairs a path that is a suffix of a real one', () => {
    const out = normaliseComments(
      { comments: [{ file: 'app.ts', line: 2, message: 'hi' }] },
      DIFF,
    );
    expect(out[0]?.file).toBe('src/app.ts');
  });

  it('falls back to the only file when the path is unrecognisable', () => {
    const out = normaliseComments(
      { comments: [{ file: 'totally/wrong.ts', line: 2, message: 'hi' }] },
      DIFF,
    );
    expect(out[0]?.file).toBe('src/app.ts');
  });

  it('drops a comment naming an unknown file when several files changed', () => {
    const twoFiles = parseUnifiedDiff(
      [
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1,1 +1,2 @@',
        ' x',
        '+y',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -1,1 +1,2 @@',
        ' x',
        '+y',
      ].join('\n'),
    );
    const warn = vi.fn();
    const out = normaliseComments(
      { comments: [{ file: 'three.ts', line: 2, message: 'hi' }] },
      twoFiles,
      warn,
    );
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown file'));
  });

  it('snaps a nearby line onto a line the diff actually changed', () => {
    // The diff adds lines 2 and 3; a comment on 4 snaps back to 3.
    const out = normaliseComments(
      { comments: [{ file: 'src/app.ts', line: 4, message: 'hi' }] },
      DIFF,
    );
    expect(out[0]?.line).toBe(3);
  });

  it('demotes a wildly wrong line number to a file-level comment', () => {
    const out = normaliseComments(
      { comments: [{ file: 'src/app.ts', line: 900, message: 'hi' }] },
      DIFF,
    );
    expect(out[0]?.line).toBe(0);
  });

  it('defaults an unknown severity to warning and a missing category to general', () => {
    const out = normaliseComments(
      { comments: [{ file: 'src/app.ts', line: 2, severity: 'catastrophic', message: 'hi' }] },
      DIFF,
    );
    expect(out[0]?.severity).toBe('warning');
    expect(out[0]?.category).toBe('general');
  });

  it('drops a null suggestion rather than emitting one', () => {
    const out = normaliseComments(
      { comments: [{ file: 'src/app.ts', line: 2, message: 'hi', suggestion: null }] },
      DIFF,
    );
    expect(out[0]?.suggestion).toBeUndefined();
  });
});

describe('sortComments', () => {
  it('orders by severity, then file, then line', () => {
    const comments: ReviewComment[] = [
      { file: 'b.ts', line: 5, severity: 'info', category: 'x', message: '1' },
      { file: 'a.ts', line: 9, severity: 'error', category: 'x', message: '2' },
      { file: 'a.ts', line: 1, severity: 'error', category: 'x', message: '3' },
      { file: 'a.ts', line: 2, severity: 'warning', category: 'x', message: '4' },
    ];
    expect(sortComments(comments).map((c) => c.message)).toEqual(['3', '2', '4', '1']);
  });
});

describe('meetsThreshold', () => {
  it('never blocks when failOn is never', () => {
    expect(meetsThreshold('error', 'never')).toBe(false);
  });

  it('blocks at and above the threshold only', () => {
    expect(meetsThreshold('error', 'warning')).toBe(true);
    expect(meetsThreshold('warning', 'warning')).toBe(true);
    expect(meetsThreshold('info', 'warning')).toBe(false);
    expect(meetsThreshold('warning', 'error')).toBe(false);
  });
});

describe('sliceLines', () => {
  const code = ['one', 'two', 'three', 'four', 'five'].join('\n');

  it('slices an inclusive 1-based range', () => {
    expect(sliceLines(code, '2:4')).toEqual({ text: 'two\nthree\nfour', start: 2, end: 4 });
  });

  it('accepts a hyphen separator and a single line', () => {
    expect(sliceLines(code, '2-3').text).toBe('two\nthree');
    expect(sliceLines(code, '3').text).toBe('three');
  });

  it('clamps the end to the file length', () => {
    expect(sliceLines(code, '4:999').end).toBe(5);
  });

  it('rejects a malformed, inverted or out-of-range spec', () => {
    expect(() => sliceLines(code, 'abc')).toThrow(UsageError);
    expect(() => sliceLines(code, '4:2')).toThrow(/ends before it starts/);
    expect(() => sliceLines(code, '99:100')).toThrow(/past the end/);
  });
});

describe('stripCodeFence', () => {
  it('removes a fenced block, with or without a language tag', () => {
    expect(stripCodeFence('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(stripCodeFence('```\nplain\n```')).toBe('plain');
  });

  it('leaves unfenced text alone', () => {
    expect(stripCodeFence('const a = 1;')).toBe('const a = 1;');
  });

  it('does not strip a fence that is only part of the output', () => {
    const text = 'here you go:\n```ts\nconst a = 1;\n```\nhope that helps';
    expect(stripCodeFence(text)).toBe(text);
  });
});
