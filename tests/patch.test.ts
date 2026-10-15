import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../src/git/diff.js';
import {
  applyHunksToText,
  applyPatch,
  safeResolve,
  summarisePatch,
  type PatchFs,
} from '../src/output/patch.js';
import { PatchError } from '../src/kernel/errors.js';
import { makeTempDir, type TempDir } from './helpers.js';

const ORIGINAL = ['line1', 'line2', 'line3', 'line4', 'line5', ''].join('\n');

const PATCH = [
  'diff --git a/file.txt b/file.txt',
  '--- a/file.txt',
  '+++ b/file.txt',
  '@@ -1,5 +1,5 @@',
  ' line1',
  ' line2',
  '-line3',
  '+line3-changed',
  ' line4',
  ' line5',
].join('\n');

describe('applyHunksToText', () => {
  it('replaces matched lines and preserves the trailing newline', () => {
    const { text, rejected } = applyHunksToText(ORIGINAL, parseUnifiedDiff(PATCH)[0]!.hunks);
    expect(rejected).toHaveLength(0);
    expect(text).toBe(['line1', 'line2', 'line3-changed', 'line4', 'line5', ''].join('\n'));
  });

  it('rejects a hunk whose context does not match', () => {
    const { text, rejected } = applyHunksToText(
      'completely\ndifferent\ncontent\n',
      parseUnifiedDiff(PATCH)[0]!.hunks,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('context did not match');
    expect(text).toBe('completely\ndifferent\ncontent\n');
  });

  it('finds context that has drifted from the stated line number', () => {
    const shifted = ['header', 'header2', ...ORIGINAL.split('\n')].join('\n');
    const { text, rejected } = applyHunksToText(shifted, parseUnifiedDiff(PATCH)[0]!.hunks);
    expect(rejected).toHaveLength(0);
    expect(text).toContain('line3-changed');
    expect(text.startsWith('header\nheader2\n')).toBe(true);
  });

  it('applies several hunks, accounting for the line shift each one causes', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const patch = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -2,3 +2,4 @@',
      ' line2',
      ' line3',
      '+inserted',
      ' line4',
      '@@ -15,3 +16,3 @@',
      ' line15',
      '-line16',
      '+line16-changed',
      ' line17',
    ].join('\n');

    const { text, rejected } = applyHunksToText(original, parseUnifiedDiff(patch)[0]!.hunks);
    expect(rejected).toHaveLength(0);
    const lines = text.split('\n');
    expect(lines[3]).toBe('inserted');
    expect(text).toContain('line16-changed');
  });

  it('preserves CRLF line endings', () => {
    const crlf = ORIGINAL.replace(/\n/g, '\r\n');
    const { text } = applyHunksToText(crlf, parseUnifiedDiff(PATCH)[0]!.hunks);
    expect(text).toContain('\r\n');
    expect(text).toContain('line3-changed');
  });
});

describe('safeResolve', () => {
  it('rejects traversal and absolute paths in model-supplied patches', () => {
    expect(() => safeResolve('/work', '../etc/passwd')).toThrow(PatchError);
    expect(() => safeResolve('/work', 'a/../../etc/passwd')).toThrow(PatchError);
    expect(() => safeResolve('/work', '/etc/passwd')).toThrow(PatchError);
  });

  it('accepts a path inside the working directory', () => {
    expect(() => safeResolve(process.cwd(), 'src/app.ts')).not.toThrow();
  });
});

describe('applyPatch', () => {
  let dir: TempDir;

  beforeEach(() => {
    dir = makeTempDir();
    dir.file('file.txt', ORIGINAL);
  });
  afterEach(() => dir.cleanup());

  it('writes nothing in dry-run mode but still reports the change', async () => {
    const result = await applyPatch(parseUnifiedDiff(PATCH), { cwd: dir.path, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path: 'file.txt', kind: 'modify' });
    expect(result.changes[0]?.contents).toContain('line3-changed');
    // The point of a dry run: disk is untouched.
    expect(readFileSync(join(dir.path, 'file.txt'), 'utf8')).toBe(ORIGINAL);
  });

  it('writes the file when not a dry run, and matches the dry-run preview exactly', async () => {
    const preview = await applyPatch(parseUnifiedDiff(PATCH), { cwd: dir.path, dryRun: true });
    const applied = await applyPatch(parseUnifiedDiff(PATCH), { cwd: dir.path, dryRun: false });

    expect(applied.changes[0]?.contents).toBe(preview.changes[0]?.contents);
    expect(readFileSync(join(dir.path, 'file.txt'), 'utf8')).toBe(applied.changes[0]?.contents);
  });

  it('creates a new file', async () => {
    const patch = [
      'diff --git a/nested/new.txt b/nested/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/nested/new.txt',
      '@@ -0,0 +1,2 @@',
      '+alpha',
      '+beta',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: false });
    expect(result.changes[0]?.kind).toBe('create');
    // A created file gets a trailing newline; there is no prior state to preserve.
    expect(readFileSync(join(dir.path, 'nested/new.txt'), 'utf8')).toBe('alpha\nbeta\n');
  });

  it('applies a pure-insertion hunk into an existing file', async () => {
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -2,0 +3,1 @@',
      '+inserted',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: false });
    expect(result.rejected).toHaveLength(0);
    expect(readFileSync(join(dir.path, 'file.txt'), 'utf8')).toBe(
      ['line1', 'line2', 'inserted', 'line3', 'line4', 'line5', ''].join('\n'),
    );
  });

  it('deletes a file', async () => {
    const patch = [
      'diff --git a/file.txt b/file.txt',
      'deleted file mode 100644',
      '--- a/file.txt',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '-line1',
      '-line2',
      '-line3',
      '-line4',
      '-line5',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: false });
    expect(result.changes[0]?.kind).toBe('delete');
    expect(existsSync(join(dir.path, 'file.txt'))).toBe(false);
  });

  it('leaves a file untouched when any of its hunks is rejected', async () => {
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-ok',
      ' line3',
      '@@ -40,3 +40,3 @@',
      ' nope',
      '-nope2',
      '+nope3',
      ' nope4',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: false });
    expect(result.rejected).toHaveLength(1);
    expect(result.changes).toHaveLength(0);
    expect(readFileSync(join(dir.path, 'file.txt'), 'utf8')).toBe(ORIGINAL);
  });

  it('skips binary patches, missing files and unsafe paths', async () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/missing.txt b/missing.txt',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      'diff --git a/../escape.txt b/../escape.txt',
      '--- a/../escape.txt',
      '+++ b/../escape.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: true });
    expect(result.changes).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'binary patch is not supported',
      'file does not exist',
      expect.stringContaining('outside the working directory'),
    ]);
  });

  it('refuses to create a file that already exists', async () => {
    const patch = [
      'diff --git a/file.txt b/file.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/file.txt',
      '@@ -0,0 +1,1 @@',
      '+clobber',
    ].join('\n');

    const result = await applyPatch(parseUnifiedDiff(patch), { cwd: dir.path, dryRun: false });
    expect(result.changes).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('already exists');
    expect(readFileSync(join(dir.path, 'file.txt'), 'utf8')).toBe(ORIGINAL);
  });

  it('uses an injected filesystem when given one', async () => {
    const writes: Array<[string, string]> = [];
    const fs: PatchFs = {
      exists: () => true,
      read: async () => ORIGINAL,
      write: async (path, contents) => void writes.push([path, contents]),
      remove: async () => {},
    };

    await applyPatch(parseUnifiedDiff(PATCH), { cwd: dir.path, dryRun: false, fs });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toContain('line3-changed');
  });
});

describe('summarisePatch', () => {
  it('describes what happened, and distinguishes dry runs', () => {
    const base = { rejected: [], skipped: [], dryRun: false };
    expect(
      summarisePatch({
        ...base,
        changes: [
          { path: 'a', kind: 'create' },
          { path: 'b', kind: 'modify' },
          { path: 'c', kind: 'delete' },
        ],
      }),
    ).toBe('applied: 1 created, 1 modified, 1 deleted');

    expect(
      summarisePatch({ ...base, dryRun: true, changes: [{ path: 'a', kind: 'modify' }] }),
    ).toBe('would apply: 1 modified');

    expect(summarisePatch({ ...base, changes: [] })).toBe('no changes');
  });
});
