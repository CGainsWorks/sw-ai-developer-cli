#!/usr/bin/env node
/**
 * The one-command demo: `make demo` (or `npm run demo`).
 *
 * It runs the real CLI against a real diff, with a stub provider supplied by
 * an out-of-tree plugin. No API key, no network, and identical output on every
 * run — which is what makes the numbers in the README reproducible.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'swai.js');
const PLUGIN = join(ROOT, 'examples', 'plugins', 'stub-provider.mjs');
const FIXTURE = join(ROOT, 'examples', 'demo');

const BOLD = process.stdout.isTTY ? '[1m' : '';
const DIM = process.stdout.isTTY ? '[2m' : '';
const RESET = process.stdout.isTTY ? '[0m' : '';

if (!existsSync(join(ROOT, 'dist', 'cli', 'run.js'))) {
  console.error('The CLI is not built yet. Run `npm run build` first (or `make demo`).');
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), 'swai-demo-'));
cpSync(FIXTURE, workspace, { recursive: true });

let failures = 0;

/**
 * Runs the CLI and reports the exit code against what the step expects.
 *
 * `expect` is asserted rather than printed as decoration: a demo that quietly
 * tolerates a wrong exit code is not evidence of anything.
 */
function step({ title, note, args, expect: expected }) {
  console.log(`\n${BOLD}$ swai ${args.join(' ')}${RESET}`);
  if (note) console.log(`${DIM}${note}${RESET}`);
  console.log();

  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  const code = result.status ?? 1;
  if (code === expected) {
    console.log(`${DIM}-> exit ${code} (expected ${expected}) — ${title}${RESET}`);
  } else {
    failures++;
    console.log(`${BOLD}!! exit ${code}, expected ${expected} — ${title}${RESET}`);
  }
  return { code, stdout: result.stdout ?? '' };
}

const provider = ['--provider', 'stub', '--plugin', PLUGIN, '--no-color'];

console.log(`${BOLD}sw-ai-developer-cli demo${RESET}`);
console.log(`${DIM}Workspace: ${workspace}${RESET}`);
console.log(
  `${DIM}All model calls are served by an offline stub provider registered by an\n` +
    `out-of-tree plugin, so this runs with no API key and produces the same\n` +
    `output every time.${RESET}`,
);

step({
  title: 'the plugin list includes the out-of-tree plugin',
  note: 'Every command below is contributed by a plugin — including the built-in three.',
  args: [...provider, 'plugins'],
  expect: 0,
});

step({
  title: 'review reports findings and gates CI with exit 5',
  note: 'Two findings come from the model; the third is a deterministic rule from review-policy.',
  args: [...provider, 'review', '--patch-file', 'cart.diff'],
  expect: 5,
});

step({
  title: '--fail-on never reports the same findings without failing the build',
  args: [...provider, 'review', '--patch-file', 'cart.diff', '--fail-on', 'never'],
  expect: 0,
});

step({
  title: 'explain summarises a file',
  args: [...provider, 'explain', 'src/cart.js', '--detail', 'brief'],
  expect: 0,
});

step({
  title: 'generate writes a new file',
  args: [...provider, 'generate', 'a retry wrapper with exponential backoff', '-o', 'src/retry.js'],
  expect: 0,
});

step({
  title: 'the plugin can contribute its own command too',
  args: [...provider, 'stub-info'],
  expect: 0,
});

const json = step({
  title: 'the same review as a single JSON document, with token and cost accounting',
  note: 'This is the shape a CI job would parse.',
  args: [...provider, 'review', '--patch-file', 'cart.diff', '--json'],
  expect: 5,
});

console.log(`\n${BOLD}Generated file${RESET} ${DIM}(${relative(workspace, join(workspace, 'src/retry.js'))})${RESET}\n`);
console.log(readFileSync(join(workspace, 'src', 'retry.js'), 'utf8'));

try {
  const parsed = JSON.parse(json.stdout);
  console.log(`${BOLD}Summary${RESET}`);
  console.log(`  findings:      ${parsed.comments.length}`);
  console.log(`  blocking:      ${parsed.blocking}`);
  console.log(`  files changed: ${parsed.stats.files} (+${parsed.stats.additions}/-${parsed.stats.deletions})`);
  console.log(`  model calls:   ${parsed.usage.calls}`);
  console.log(`  tokens:        ${parsed.usage.inputTokens} in / ${parsed.usage.outputTokens} out`);
  console.log(
    `  cost:          ${
      parsed.usage.costUsd === null
        ? 'unknown (the stub model has no price entry — real providers are priced)'
        : `$${parsed.usage.costUsd}`
    }`,
  );
} catch {
  failures++;
  console.log('!! could not parse the JSON output');
}

rmSync(workspace, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} demo step(s) did not behave as documented.`);
  process.exit(1);
}
console.log(`\n${BOLD}Demo complete.${RESET} Every step exited with the documented code.`);
