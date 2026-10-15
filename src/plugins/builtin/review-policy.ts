/**
 * Reference plugin #2 — hooks only, no command.
 *
 * It does three things to the `review` output, all through `reviewComments`:
 *
 *   1. Adds deterministic findings that a model is unreliable at: forbidden
 *      patterns on added lines (`debugger`, `console.log`, a hardcoded key).
 *      These are grep rules — running them through an LLM would be slower,
 *      costlier and less repeatable.
 *   2. Escalates or demotes model findings by category.
 *   3. Drops categories the project does not care about, and caps per-file noise.
 *
 * Config (`pluginConfig["review-policy"]`):
 *   {
 *     "forbiddenPatterns": [
 *       { "pattern": "\\bdebugger\\b", "message": "debugger statement left in", "severity": "error" }
 *     ],
 *     "escalate":  { "security": "error" },
 *     "demote":    { "style": "info" },
 *     "dropCategories": ["style"],
 *     "maxPerFile": 10,
 *     "builtinPatterns": true
 *   }
 */

import { SEVERITIES, type Severity } from '../../config/types.js';
import { changedLineNumbers, targetPath, type FileDiff } from '../../git/diff.js';
import {
  definePlugin,
  PLUGIN_API_VERSION,
  type ReviewComment,
  type ReviewCommentsEvent,
} from '../api.js';

export const PLUGIN_NAME = 'review-policy';

export interface ForbiddenPattern {
  pattern: string;
  message: string;
  severity?: Severity;
  category?: string;
  /** RegExp flags, e.g. `"i"`. Defaults to none — matching is case-sensitive. */
  flags?: string;
  /** Only apply to files whose path ends with one of these. */
  extensions?: string[];
}

export interface ReviewPolicySettings {
  forbiddenPatterns?: ForbiddenPattern[];
  builtinPatterns?: boolean;
  escalate?: Record<string, Severity>;
  demote?: Record<string, Severity>;
  dropCategories?: string[];
  maxPerFile?: number;
}

/**
 * Patterns that are almost always a mistake in committed code. Deliberately
 * conservative — a false positive here costs a reviewer's attention, which is
 * the exact resource this tool exists to protect.
 */
export const BUILTIN_PATTERNS: ForbiddenPattern[] = [
  {
    pattern: '\\bdebugger\\b',
    message: 'A `debugger` statement is left in this change.',
    severity: 'error',
    category: 'debug-leftover',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
  },
  {
    pattern: '\\bconsole\\.(log|debug)\\s*\\(',
    message: 'Debug logging left in. Use the project logger, or delete it.',
    severity: 'warning',
    category: 'debug-leftover',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
  },
  {
    pattern: '(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*[\'"][^\'"]{12,}[\'"]',
    // Case-insensitive: `apiKey`, `API_KEY` and `apikey` are all the same risk.
    flags: 'i',
    message: 'This looks like a hardcoded credential. Move it to the environment.',
    severity: 'error',
    category: 'security',
  },
  {
    pattern: '\\.only\\s*\\(',
    message: 'A focused test (`.only`) will silently skip the rest of the suite in CI.',
    severity: 'error',
    category: 'test-hygiene',
    extensions: ['.js', '.ts', '.tsx', '.jsx', '.mjs'],
  },
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export function scanForbiddenPatterns(
  files: FileDiff[],
  patterns: ForbiddenPattern[],
): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const changed = changedLineNumbers(files);

  for (const file of files) {
    if (file.isBinary) continue;
    const path = targetPath(file);
    const addedLines = changed.get(path);
    if (!addedLines || addedLines.size === 0) continue;

    for (const rule of patterns) {
      if (rule.extensions && !rule.extensions.some((ext) => path.endsWith(ext))) continue;

      let regex: RegExp;
      try {
        // `g`/`y` would make `.test()` stateful across lines, so they are
        // stripped rather than trusted from user config.
        regex = new RegExp(rule.pattern, (rule.flags ?? '').replace(/[gy]/g, ''));
      } catch {
        // A bad pattern in user config should not take the review down.
        continue;
      }

      for (const hunk of file.hunks) {
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
          if (line.type === 'remove') continue;
          if (line.type === 'add' && regex.test(line.text)) {
            comments.push({
              file: path,
              line: newLine,
              severity: rule.severity ?? 'warning',
              category: rule.category ?? 'policy',
              message: rule.message,
              source: PLUGIN_NAME,
            });
          }
          newLine++;
        }
      }
    }
  }

  return comments;
}

export function applyPolicy(
  comments: ReviewComment[],
  settings: ReviewPolicySettings,
): ReviewComment[] {
  const drop = new Set(settings.dropCategories ?? []);
  const escalate = settings.escalate ?? {};
  const demote = settings.demote ?? {};

  let out = comments
    .filter((c) => !drop.has(c.category))
    .map((c) => {
      const target = escalate[c.category] ?? demote[c.category];
      if (!target || !SEVERITIES.includes(target)) return c;

      const escalating = escalate[c.category] !== undefined;
      // Escalation only ever raises, demotion only ever lowers. Otherwise a
      // config with both listed would flip a finding back and forth depending
      // on key order.
      const shouldChange = escalating
        ? SEVERITY_RANK[target] > SEVERITY_RANK[c.severity]
        : SEVERITY_RANK[target] < SEVERITY_RANK[c.severity];
      return shouldChange ? { ...c, severity: target } : c;
    });

  const maxPerFile = settings.maxPerFile;
  if (maxPerFile !== undefined && maxPerFile >= 0) {
    const seen = new Map<string, number>();
    out = out.filter((c) => {
      const count = seen.get(c.file) ?? 0;
      if (count >= maxPerFile) return false;
      seen.set(c.file, count + 1);
      return true;
    });
  }

  return out;
}

/** Same file, same line, same category — keep the more severe one. */
export function dedupe(comments: ReviewComment[]): ReviewComment[] {
  const byKey = new Map<string, ReviewComment>();
  for (const comment of comments) {
    const key = `${comment.file}:${comment.line}:${comment.category}`;
    const existing = byKey.get(key);
    if (!existing || SEVERITY_RANK[comment.severity] > SEVERITY_RANK[existing.severity]) {
      byKey.set(key, comment);
    }
  }
  return [...byKey.values()];
}

export function reviewCommentsHook(
  event: ReviewCommentsEvent,
  settings: ReviewPolicySettings,
): ReviewComment[] {
  const patterns = [
    ...(settings.builtinPatterns === false ? [] : BUILTIN_PATTERNS),
    ...(settings.forbiddenPatterns ?? []),
  ];

  const scanned = scanForbiddenPatterns(event.diff, patterns);
  return applyPolicy(dedupe([...event.comments, ...scanned]), settings);
}

export default definePlugin({
  name: PLUGIN_NAME,
  apiVersion: PLUGIN_API_VERSION,
  version: '1.0.0',
  description:
    'Adds deterministic pattern findings to `review`, and applies category escalation and noise caps.',
  setup(ctx) {
    const settings = ctx.settings as ReviewPolicySettings;
    ctx.addHooks({
      reviewComments: (event) => reviewCommentsHook(event, settings),
    });
  },
});
