import { describe, expect, it } from 'vitest';

import {
  annotateForReview,
  changedLineNumbers,
  diffStats,
  parseUnifiedDiff,
  stripPathPrefix,
  targetPath,
} from '../src/git/diff.js';

const SIMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ export function run() {
   const a = 1;
   const b = 2;
-  return a + b;
+  const c = 3;
+  return a + b + c;
 }

 export const x = 1;
`;

describe('parseUnifiedDiff', () => {
  it('parses paths, hunk ranges and line types', () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    expect(file?.oldPath).toBe('src/app.ts');
    expect(file?.newPath).toBe('src/app.ts');
    expect(file?.hunks).toHaveLength(1);

    const hunk = file?.hunks[0];
    expect(hunk?.oldStart).toBe(10);
    expect(hunk?.oldLines).toBe(7);
    expect(hunk?.newStart).toBe(10);
    expect(hunk?.newLines).toBe(8);
    expect(hunk?.heading).toBe('export function run() {');

    expect(hunk?.lines.filter((l) => l.type === 'add')).toHaveLength(2);
    expect(hunk?.lines.filter((l) => l.type === 'remove')).toHaveLength(1);
  });

  it('treats an omitted hunk count as 1', () => {
    const [file] = parseUnifiedDiff(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -5 +5 @@', '-old', '+new'].join('\n'),
    );
    expect(file?.hunks[0]?.oldLines).toBe(1);
    expect(file?.hunks[0]?.newLines).toBe(1);
  });

  it('flags added and deleted files', () => {
    const added = parseUnifiedDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+export const a = 1;',
        '+export const b = 2;',
      ].join('\n'),
    );
    expect(added[0]?.isNew).toBe(true);
    expect(targetPath(added[0]!)).toBe('new.ts');

    const deleted = parseUnifiedDiff(
      [
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-export const a = 1;',
        '-export const b = 2;',
      ].join('\n'),
    );
    expect(deleted[0]?.isDeleted).toBe(true);
    expect(targetPath(deleted[0]!)).toBe('gone.ts');
  });

  it('recognises renames and binary patches without trying to parse them', () => {
    const renamed = parseUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts',
      ].join('\n'),
    );
    expect(renamed[0]?.isRename).toBe(true);
    expect(renamed[0]?.oldPath).toBe('old.ts');
    expect(renamed[0]?.newPath).toBe('new.ts');

    const binary = parseUnifiedDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index 111..222 100644',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    );
    expect(binary[0]?.isBinary).toBe(true);
    expect(binary[0]?.hunks).toHaveLength(0);
  });

  it('attaches the no-newline marker to the preceding line', () => {
    const [file] = parseUnifiedDiff(
      [
        '--- a/x.txt',
        '+++ b/x.txt',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(file?.hunks[0]?.lines.at(-1)?.noNewline).toBe(true);
  });

  it('handles multiple files in one patch', () => {
    const files = parseUnifiedDiff(
      SIMPLE +
        [
          'diff --git a/src/other.ts b/src/other.ts',
          '--- a/src/other.ts',
          '+++ b/src/other.ts',
          '@@ -1,2 +1,2 @@',
          '-const a = 1;',
          '+const a = 2;',
          ' const b = 3;',
        ].join('\n'),
    );
    expect(files.map(targetPath)).toEqual(['src/app.ts', 'src/other.ts']);
  });

  it('parses a bare patch with no `diff --git` preamble', () => {
    const files = parseUnifiedDiff(
      ['--- a/bare.ts', '+++ b/bare.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n'),
    );
    expect(files).toHaveLength(1);
    expect(targetPath(files[0]!)).toBe('bare.ts');
  });

  it('returns nothing for an empty or non-diff input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('just some prose\nwith no diff in it')).toEqual([]);
  });
});

describe('stripPathPrefix', () => {
  it('removes a/ and b/ prefixes but preserves /dev/null', () => {
    expect(stripPathPrefix('a/src/app.ts')).toBe('src/app.ts');
    expect(stripPathPrefix('b/src/app.ts')).toBe('src/app.ts');
    expect(stripPathPrefix('/dev/null')).toBe('/dev/null');
  });

  it('drops a trailing tab-separated timestamp', () => {
    expect(stripPathPrefix('a/src/app.ts\t2026-01-01 00:00:00')).toBe('src/app.ts');
  });
});

describe('annotateForReview', () => {
  it('numbers lines with post-change line numbers', () => {
    const annotated = annotateForReview(parseUnifiedDiff(SIMPLE));
    expect(annotated).toContain('--- src/app.ts ---');
    // The first context line of the hunk starts at newStart (10).
    expect(annotated).toContain('    10 |   const a = 1;');
    // Removed lines carry no new-file number.
    expect(annotated).toContain('     - |   return a + b;');
    // Added lines are marked with `+` and keep counting from there.
    expect(annotated).toContain('    12+|   const c = 3;');
    expect(annotated).toContain('    13+|   return a + b + c;');
  });

  it('marks binary files as skipped instead of emitting content', () => {
    const annotated = annotateForReview([
      { oldPath: 'x.png', newPath: 'x.png', hunks: [], isNew: false, isDeleted: false, isRename: false, isBinary: true },
    ]);
    expect(annotated).toBe('--- x.png (binary, skipped) ---');
  });
});

describe('changedLineNumbers', () => {
  it('reports only the lines the patch adds', () => {
    const map = changedLineNumbers(parseUnifiedDiff(SIMPLE));
    expect([...(map.get('src/app.ts') ?? [])].sort((a, b) => a - b)).toEqual([12, 13]);
  });
});

describe('diffStats', () => {
  it('counts files, additions and deletions', () => {
    expect(diffStats(parseUnifiedDiff(SIMPLE))).toEqual({
      files: 1,
      additions: 2,
      deletions: 1,
    });
  });
});
