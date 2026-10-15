import type { Plugin } from '../api.js';

import providers from './providers.js';
import introspect from './introspect.js';
import generate from '../../commands/generate.js';
import review from '../../commands/review.js';
import explain from '../../commands/explain.js';
import conventionalCommits from './conventional-commits.js';
import reviewPolicy from './review-policy.js';

/**
 * Plugins loaded by default, in order.
 *
 * `generate`, `review` and `explain` are in this list on exactly the same
 * terms as the two reference plugins — the kernel has no notion of a "core"
 * command. Any of them can be turned off with `--disable-plugin <name>`, which
 * is the cheapest available proof that the plugin API is load-bearing rather
 * than decorative.
 */
export const BUILTIN_PLUGINS: readonly Plugin[] = [
  providers,
  introspect,
  generate,
  review,
  explain,
  conventionalCommits,
  reviewPolicy,
];

export {
  providers,
  introspect,
  generate,
  review,
  explain,
  conventionalCommits,
  reviewPolicy,
};
