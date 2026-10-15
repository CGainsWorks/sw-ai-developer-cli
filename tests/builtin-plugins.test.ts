import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PATTERNS,
  applyPolicy,
  dedupe,
  reviewCommentsHook,
  scanForbiddenPatterns,
} from '../src/plugins/builtin/review-policy.js';
import {
  cleanMessage,
  validateMessage,
  DEFAULT_TYPES,
  DEFAULT_SUBJECT_MAX_LENGTH,
} from '../src/plugins/builtin/conventional-commits.js';
import { parseUnifiedDiff } from '../src/git/diff.js';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin/index.js';
import { PLUGIN_API_VERSION } from '../src/plugins/api.js';
import type { ReviewComment } from '../src/plugins/api.js';

const DIRTY_DIFF = parseUnifiedDiff(
  [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,6 @@',
    ' const a = 1;',
    '+debugger;',
    '+console.log("here");',
    '+const apiKey = "sk-abcdefghijklmnop";',
    '+const fine = 1;',
    ' const b = 2;',
  ].join('\n'),
);

describe('review-policy: scanForbiddenPatterns', () => {
  it('flags debug leftovers and hardcoded credentials on added lines', () => {
    const found = scanForbiddenPatterns(DIRTY_DIFF, BUILTIN_PATTERNS);
    const categories = found.map((c) => c.category).sort();
    expect(categories).toEqual(['debug-leftover', 'debug-leftover', 'security']);
    expect(found.every((c) => c.source === 'review-policy')).toBe(true);
  });

  it('reports the correct post-change line numbers', () => {
    const found = scanForbiddenPatterns(DIRTY_DIFF, BUILTIN_PATTERNS);
    const debuggerFinding = found.find((c) => c.message.includes('debugger'));
    expect(debuggerFinding?.line).toBe(2);
  });

  it('ignores context and removed lines', () => {
    const diff = parseUnifiedDiff(
      [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@',
        ' debugger;',
        '-console.log("gone");',
        '+const clean = 1;',
      ].join('\n'),
    );
    expect(scanForbiddenPatterns(diff, BUILTIN_PATTERNS)).toEqual([]);
  });

  it('honours the extension filter', () => {
    const diff = parseUnifiedDiff(
      ['--- a/notes.md', '+++ b/notes.md', '@@ -1,1 +1,2 @@', ' x', '+debugger;'].join('\n'),
    );
    expect(scanForbiddenPatterns(diff, BUILTIN_PATTERNS)).toEqual([]);
  });

  it('skips an invalid user-supplied regex instead of failing the review', () => {
    expect(() =>
      scanForbiddenPatterns(DIRTY_DIFF, [{ pattern: '([unclosed', message: 'x' }]),
    ).not.toThrow();
    expect(scanForbiddenPatterns(DIRTY_DIFF, [{ pattern: '([unclosed', message: 'x' }])).toEqual([]);
  });

  it('skips binary files', () => {
    const binary = parseUnifiedDiff(
      ['diff --git a/x.png b/x.png', 'Binary files a/x.png and b/x.png differ'].join('\n'),
    );
    expect(scanForbiddenPatterns(binary, BUILTIN_PATTERNS)).toEqual([]);
  });
});

describe('review-policy: applyPolicy', () => {
  const comments: ReviewComment[] = [
    { file: 'a.ts', line: 1, severity: 'info', category: 'security', message: 's' },
    { file: 'a.ts', line: 2, severity: 'error', category: 'style', message: 'st' },
    { file: 'a.ts', line: 3, severity: 'warning', category: 'other', message: 'o' },
  ];

  it('escalates a category upward only', () => {
    const out = applyPolicy(comments, { escalate: { security: 'error' } });
    expect(out.find((c) => c.category === 'security')?.severity).toBe('error');
    // An escalation rule must never quietly lower an existing severity.
    const noDowngrade = applyPolicy(comments, { escalate: { style: 'info' } });
    expect(noDowngrade.find((c) => c.category === 'style')?.severity).toBe('error');
  });

  it('demotes a category downward only', () => {
    const out = applyPolicy(comments, { demote: { style: 'info' } });
    expect(out.find((c) => c.category === 'style')?.severity).toBe('info');
    const noUpgrade = applyPolicy(comments, { demote: { security: 'error' } });
    expect(noUpgrade.find((c) => c.category === 'security')?.severity).toBe('info');
  });

  it('drops unwanted categories', () => {
    const out = applyPolicy(comments, { dropCategories: ['style'] });
    expect(out.map((c) => c.category)).toEqual(['security', 'other']);
  });

  it('caps comments per file', () => {
    const out = applyPolicy(comments, { maxPerFile: 2 });
    expect(out).toHaveLength(2);
  });

  it('ignores an unknown severity in the config', () => {
    const out = applyPolicy(comments, { escalate: { security: 'nuclear' as never } });
    expect(out.find((c) => c.category === 'security')?.severity).toBe('info');
  });
});

describe('review-policy: dedupe', () => {
  it('keeps the most severe of duplicates at the same file, line and category', () => {
    const out = dedupe([
      { file: 'a.ts', line: 1, severity: 'info', category: 'x', message: 'low' },
      { file: 'a.ts', line: 1, severity: 'error', category: 'x', message: 'high' },
      { file: 'a.ts', line: 2, severity: 'info', category: 'x', message: 'other line' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.line === 1)?.message).toBe('high');
  });
});

describe('review-policy: the hook end to end', () => {
  it('merges model findings with pattern findings and applies policy', () => {
    const modelComments: ReviewComment[] = [
      { file: 'src/app.ts', line: 5, severity: 'info', category: 'style', message: 'nit' },
    ];
    const out = reviewCommentsHook(
      { comments: modelComments, diff: DIRTY_DIFF, config: {} as never },
      { dropCategories: ['style'] },
    );
    expect(out.map((c) => c.category).sort()).toEqual([
      'debug-leftover',
      'debug-leftover',
      'security',
    ]);
  });

  it('can be told to skip the built-in patterns', () => {
    const out = reviewCommentsHook(
      { comments: [], diff: DIRTY_DIFF, config: {} as never },
      { builtinPatterns: false },
    );
    expect(out).toEqual([]);
  });

  it('adds user-supplied patterns', () => {
    const out = reviewCommentsHook(
      { comments: [], diff: DIRTY_DIFF, config: {} as never },
      {
        builtinPatterns: false,
        forbiddenPatterns: [{ pattern: 'const fine', message: 'not fine', severity: 'error' }],
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe('not fine');
  });
});

describe('conventional-commits: validateMessage', () => {
  const options = { types: DEFAULT_TYPES, subjectMaxLength: DEFAULT_SUBJECT_MAX_LENGTH };

  it('accepts a well-formed message', () => {
    expect(validateMessage('feat(parser): add unified diff support', options)).toEqual({
      valid: true,
      problems: [],
    });
  });

  it('accepts a scopeless message and a breaking-change marker', () => {
    expect(validateMessage('fix: handle empty diffs', options).valid).toBe(true);
    expect(validateMessage('feat(api)!: drop the v1 endpoint', options).valid).toBe(true);
  });

  it('rejects a malformed header', () => {
    const result = validateMessage('just some words', options);
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toContain('does not match');
  });

  it('reports an unknown type', () => {
    expect(validateMessage('wibble: do a thing', options).problems).toEqual([
      expect.stringContaining('unknown type "wibble"'),
    ]);
  });

  it('reports an over-long subject, a trailing stop and a capitalised subject', () => {
    expect(
      validateMessage(`feat: ${'x'.repeat(100)}`, options).problems.join(' '),
    ).toContain('limit is 72');
    expect(validateMessage('feat: add a thing.', options).problems.join(' ')).toContain(
      'full stop',
    );
    expect(validateMessage('feat: Add a thing', options).problems.join(' ')).toContain(
      'capital letter',
    );
  });

  it('requires a blank line before the body', () => {
    expect(validateMessage('feat: a thing\nbody right away', options).problems.join(' ')).toContain(
      'must be blank',
    );
    expect(validateMessage('feat: a thing\n\nproper body', options).valid).toBe(true);
  });
});

describe('conventional-commits: cleanMessage', () => {
  it('unwraps a code fence and trims', () => {
    expect(cleanMessage('```\nfeat: a thing\n```')).toBe('feat: a thing');
    expect(cleanMessage('  feat: a thing  ')).toBe('feat: a thing');
  });
});

describe('BUILTIN_PLUGINS', () => {
  it('are all valid, uniquely named, and target the current API version', () => {
    const names = BUILTIN_PLUGINS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const plugin of BUILTIN_PLUGINS) {
      expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    }
  });

  it('contribute the three headline commands as ordinary plugins', () => {
    const commandOwners = BUILTIN_PLUGINS.flatMap((p) =>
      (p.commands ?? []).map((c) => [c.name, p.name] as const),
    );
    expect(commandOwners).toEqual(
      expect.arrayContaining([
        ['generate', 'generate'],
        ['review', 'review'],
        ['explain', 'explain'],
        ['commit-msg', 'conventional-commits'],
      ]),
    );
  });
});
