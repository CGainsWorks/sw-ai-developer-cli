/**
 * A minimal, dependency-free unified-diff parser.
 *
 * It handles what `git diff` actually emits for text files: multi-file
 * patches, `/dev/null` adds and deletes, renames, `\ No newline at end of
 * file`, and hunk headers with omitted counts. Binary patches are recognised
 * and flagged rather than parsed, so callers can skip them instead of
 * corrupting a file.
 */

export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** True when this line carries the `\ No newline at end of file` marker. */
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the `@@ ... @@`, usually the enclosing function. */
  heading?: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** `/dev/null` for an added file. */
  oldPath: string;
  /** `/dev/null` for a deleted file. */
  newPath: string;
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const lines = patch.split(/\r?\n/);
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let hunk: Hunk | undefined;

  const closeHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = undefined;
  };
  const closeFile = (): void => {
    closeHunk();
    if (current) files.push(current);
    current = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith('diff --git ')) {
      closeFile();
      const paths = parseDiffGitHeader(line);
      current = {
        oldPath: paths?.old ?? '',
        newPath: paths?.new ?? '',
        hunks: [],
        isNew: false,
        isDeleted: false,
        isRename: false,
        isBinary: false,
      };
      continue;
    }

    if (!current) {
      // A bare patch with no `diff --git` preamble — start a file on `---`.
      if (line.startsWith('--- ')) {
        current = {
          oldPath: stripPathPrefix(line.slice(4)),
          newPath: '',
          hunks: [],
          isNew: false,
          isDeleted: false,
          isRename: false,
          isBinary: false,
        };
      }
      continue;
    }

    if (line.startsWith('new file mode')) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.isRename = true;
      current.oldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.isRename = true;
      current.newPath = line.slice('rename to '.length).trim();
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `---` after we already have hunks means a second file in a patch
      // with no `diff --git` preamble — what `diff -u` and many tools emit.
      if (current.hunks.length > 0 || hunk) {
        closeFile();
        current = {
          oldPath: '',
          newPath: '',
          hunks: [],
          isNew: false,
          isDeleted: false,
          isRename: false,
          isBinary: false,
        };
      }
      closeHunk();
      const p = stripPathPrefix(line.slice(4));
      current.oldPath = p;
      if (p === '/dev/null') current.isNew = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPathPrefix(line.slice(4));
      current.newPath = p;
      if (p === '/dev/null') current.isDeleted = true;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      closeHunk();
      const heading = (header[5] ?? '').trim();
      hunk = {
        oldStart: Number(header[1]),
        // An omitted count means 1, per the unified diff format.
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      if (heading) hunk.heading = heading;
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` applies to the line just emitted.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({ type: 'add', text: line.slice(1) });
    } else if (marker === '-') {
      hunk.lines.push({ type: 'remove', text: line.slice(1) });
    } else if (marker === ' ') {
      hunk.lines.push({ type: 'context', text: line.slice(1) });
    } else if (line === '') {
      // git emits a bare empty line for an empty context line.
      hunk.lines.push({ type: 'context', text: '' });
    } else {
      // Anything else ends the hunk (trailing prose, `-- ` signature, etc.).
      closeHunk();
    }
  }

  closeFile();
  return files.filter((f) => f.hunks.length > 0 || f.isBinary || f.isRename);
}

function parseDiffGitHeader(line: string): { old: string; new: string } | undefined {
  // `diff --git a/x b/y`. Paths with spaces are quoted by git when
  // core.quotePath is on; handle the quoted form first.
  const quoted = /^diff --git "(.+)" "(.+)"$/.exec(line);
  if (quoted) {
    return { old: stripPathPrefix(quoted[1] as string), new: stripPathPrefix(quoted[2] as string) };
  }
  const rest = line.slice('diff --git '.length);
  const midpoint = findPathSplit(rest);
  if (midpoint < 0) return undefined;
  return {
    old: stripPathPrefix(rest.slice(0, midpoint)),
    new: stripPathPrefix(rest.slice(midpoint + 1)),
  };
}

/**
 * `a/some file.ts b/some file.ts` is ambiguous on spaces alone. Git guarantees
 * the second path starts with `b/`, so split on the first ` b/` that leaves a
 * plausible `a/` prefix behind.
 */
function findPathSplit(rest: string): number {
  const idx = rest.indexOf(' b/');
  return idx;
}

export function stripPathPrefix(path: string): string {
  const trimmed = path.trim().replace(/\t.*$/, '');
  if (trimmed === '/dev/null') return trimmed;
  return trimmed.replace(/^[ab]\//, '');
}

/** The path a file lives at after the patch applies. */
export function targetPath(file: FileDiff): string {
  return file.isDeleted ? file.oldPath : file.newPath || file.oldPath;
}

/**
 * Renders a diff with the *new-file* line numbers attached, so a model can
 * cite real line numbers instead of guessing from hunk offsets. This is the
 * representation the review prompt sends.
 */
export function annotateForReview(files: FileDiff[]): string {
  const out: string[] = [];
  for (const file of files) {
    const path = targetPath(file);
    if (file.isBinary) {
      out.push(`--- ${path} (binary, skipped) ---`);
      continue;
    }
    out.push(`--- ${path} ---`);
    for (const hunk of file.hunks) {
      out.push(`@@ ${hunk.heading ?? ''}`.trimEnd());
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.type === 'remove') {
          out.push(`     - | ${line.text}`);
        } else {
          const marker = line.type === 'add' ? '+' : ' ';
          out.push(`${String(newLine).padStart(6)}${marker}| ${line.text}`);
          newLine++;
        }
      }
    }
  }
  return out.join('\n');
}

/** Every new-file line number that the patch adds, per path. */
export function changedLineNumbers(files: FileDiff[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.isBinary) continue;
    const path = targetPath(file);
    const set = map.get(path) ?? new Set<number>();
    for (const hunk of file.hunks) {
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.type === 'add') set.add(newLine);
        if (line.type !== 'remove') newLine++;
      }
    }
    map.set(path, set);
  }
  return map;
}

export function diffStats(files: FileDiff[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') additions++;
        else if (line.type === 'remove') deletions++;
      }
    }
  }
  return { files: files.length, additions, deletions };
}
