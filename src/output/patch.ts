import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { PatchError } from '../kernel/errors.js';
import { targetPath, type FileDiff, type Hunk } from '../git/diff.js';
import type { PatchChange } from '../plugins/api.js';

export interface ApplyOptions {
  cwd: string;
  /** Compute the result and report it, but write nothing. */
  dryRun: boolean;
  /**
   * How far from the stated hunk position to search for the context lines.
   * Matches `patch --fuzz`-style tolerance for a slightly stale diff.
   */
  searchWindow?: number;
  /** Injectable filesystem, for tests. */
  fs?: PatchFs;
}

export interface PatchFs {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RejectedHunk {
  path: string;
  hunk: Hunk;
  reason: string;
}

export interface ApplyResult {
  changes: PatchChange[];
  rejected: RejectedHunk[];
  skipped: Array<{ path: string; reason: string }>;
  dryRun: boolean;
}

const nodeFs: PatchFs = {
  exists: (path) => existsSync(path),
  read: (path) => readFile(path, 'utf8'),
  write: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  },
  remove: (path) => rm(path, { force: true }),
};

/**
 * Applies a parsed unified diff to the working tree.
 *
 * Dry-run and real application share this one code path — the only difference
 * is whether the final write happens. A separate "preview" implementation
 * would eventually disagree with the real one, and the disagreement would only
 * be discovered by someone whose files got mangled.
 */
export async function applyPatch(
  files: FileDiff[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  const fs = options.fs ?? nodeFs;
  const window = options.searchWindow ?? 50;

  const changes: PatchChange[] = [];
  const rejected: RejectedHunk[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const file of files) {
    if (file.isBinary) {
      skipped.push({ path: targetPath(file), reason: 'binary patch is not supported' });
      continue;
    }

    const relPath = targetPath(file);
    let absPath: string;
    try {
      absPath = safeResolve(options.cwd, relPath);
    } catch (err) {
      skipped.push({
        path: relPath,
        reason: err instanceof Error ? err.message : 'unsafe path',
      });
      continue;
    }

    if (file.isDeleted) {
      const previous = fs.exists(absPath) ? await fs.read(absPath) : undefined;
      const change: PatchChange = { path: relPath, kind: 'delete' };
      if (previous !== undefined) change.previous = previous;
      changes.push(change);
      continue;
    }

    const exists = fs.exists(absPath);
    if (file.isNew && exists) {
      skipped.push({ path: relPath, reason: 'patch creates a file that already exists' });
      continue;
    }
    if (!file.isNew && !exists) {
      skipped.push({ path: relPath, reason: 'file does not exist' });
      continue;
    }

    const original = exists ? await fs.read(absPath) : '';
    const { text: applied, rejected: fileRejects } = applyHunksToText(
      original,
      file.hunks,
      window,
    );

    for (const reject of fileRejects) {
      rejected.push({ path: relPath, hunk: reject.hunk, reason: reject.reason });
    }

    // All-or-nothing per file: a half-applied file is worse than an unapplied
    // one, because it looks like it worked.
    if (fileRejects.length > 0) continue;
    if (applied === original && !file.isNew) continue;

    const change: PatchChange = {
      path: relPath,
      kind: file.isNew ? 'create' : 'modify',
      contents: applied,
    };
    if (exists) change.previous = original;
    changes.push(change);
  }

  if (!options.dryRun) {
    for (const change of changes) {
      const absPath = safeResolve(options.cwd, change.path);
      if (change.kind === 'delete') {
        await fs.remove(absPath);
      } else {
        await fs.write(absPath, change.contents ?? '');
      }
    }
  }

  return { changes, rejected, skipped, dryRun: options.dryRun };
}

/**
 * Rejects paths that escape the working directory.
 *
 * A patch is model output. `../../.ssh/authorized_keys` in a `+++` header must
 * not be honoured just because the rest of the diff parsed cleanly.
 */
export function safeResolve(cwd: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new PatchError(`Refusing absolute path in patch: ${relPath}`);
  }
  const abs = resolve(cwd, normalize(relPath));
  const rel = relative(resolve(cwd), abs);
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
    throw new PatchError(`Refusing path outside the working directory: ${relPath}`);
  }
  return abs;
}

interface HunkReject {
  hunk: Hunk;
  reason: string;
}

/**
 * Applies hunks to text.
 *
 * Hunks are applied in file order, and each subsequent hunk's search start is
 * shifted by the net line delta of the ones before it, so a patch whose later
 * hunk offsets assume the earlier edits still lands.
 */
export function applyHunksToText(
  original: string,
  hunks: Hunk[],
  searchWindow = 50,
): { text: string; rejected: HunkReject[] } {
  const eol = detectEol(original);
  const endsWithNewline = original.endsWith('\n') || original.endsWith('\r\n');
  const lines = splitLines(original);
  const rejected: HunkReject[] = [];

  let offset = 0;

  for (const hunk of hunks) {
    const expected = hunk.lines
      .filter((l) => l.type !== 'add')
      .map((l) => l.text);
    const replacement = hunk.lines
      .filter((l) => l.type !== 'remove')
      .map((l) => l.text);

    // A hunk with no context and no removals is a pure insertion — there is
    // nothing to match on, so it is positioned rather than searched for.
    // `@@ -0,0 +1,N @@` (a new file) inserts at 0; `@@ -5,0 +6,N @@` inserts
    // after old line 5. Both are `oldStart`.
    if (expected.length === 0) {
      const insertAt = clamp(hunk.oldStart + offset, 0, lines.length);
      lines.splice(insertAt, 0, ...replacement);
      offset += replacement.length;
      continue;
    }

    // Unified diff line numbers are 1-based.
    const nominal = hunk.oldStart - 1 + offset;
    const index = findMatch(lines, expected, nominal, searchWindow);

    if (index < 0) {
      rejected.push({ hunk, reason: `context did not match near line ${hunk.oldStart}` });
      continue;
    }

    lines.splice(index, expected.length, ...replacement);
    offset += replacement.length - expected.length;
  }

  // Preserve whether the file ended with a newline, and which newline it used.
  // A file being created has no "before" to preserve, so it gets the POSIX
  // default of a trailing newline unless the patch explicitly says otherwise.
  const lastLine = hunks.at(-1)?.lines.at(-1);
  const stripTrailing = lastLine?.noNewline === true;
  const creating = original === '';
  let text = lines.join(eol);
  if ((endsWithNewline || creating) && !stripTrailing && lines.length > 0) text += eol;

  return { text, rejected };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findMatch(
  lines: string[],
  expected: string[],
  nominal: number,
  window: number,
): number {
  if (expected.length === 0) return -1;

  const matchesAt = (start: number): boolean => {
    if (start < 0 || start + expected.length > lines.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (lines[start + i] !== expected[i]) return false;
    }
    return true;
  };

  if (matchesAt(nominal)) return nominal;

  // Spiral outward from the stated position so the nearest match wins.
  for (let delta = 1; delta <= window; delta++) {
    if (matchesAt(nominal - delta)) return nominal - delta;
    if (matchesAt(nominal + delta)) return nominal + delta;
  }
  return -1;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** A short, human-readable description of what a patch would do. */
export function summarisePatch(result: ApplyResult): string {
  const created = result.changes.filter((c) => c.kind === 'create').length;
  const modified = result.changes.filter((c) => c.kind === 'modify').length;
  const deleted = result.changes.filter((c) => c.kind === 'delete').length;

  const parts: string[] = [];
  if (created) parts.push(`${created} created`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  if (result.rejected.length) parts.push(`${result.rejected.length} hunk(s) rejected`);
  if (result.skipped.length) parts.push(`${result.skipped.length} file(s) skipped`);
  if (parts.length === 0) return 'no changes';

  const prefix = result.dryRun ? 'would apply: ' : 'applied: ';
  return prefix + parts.join(', ');
}

/** Where a `.rej` file goes for a path, mirroring `patch(1)`. */
export function rejectPathFor(cwd: string, relPath: string): string {
  return join(cwd, `${relPath}.rej`);
}
