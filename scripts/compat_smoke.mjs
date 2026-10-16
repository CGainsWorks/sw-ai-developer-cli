#!/usr/bin/env node
/**
 * Runs an installed `swai` against the mock OpenAI-compatible server.
 *
 *   node scripts/compat_smoke.mjs            # uses bin/swai.js in this checkout
 *   node scripts/compat_smoke.mjs swai       # uses whatever `swai` is on PATH
 *
 * The integration tests drive the CLI in-process. This drives the packaged
 * binary as a separate process, the way a user or a CI job would, with the
 * `compat` provider configured only through environment variables. No model,
 * key or network is involved beyond the loopback interface.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOCK_MODEL, startMockOpenAI } from '../tests/mock-openai/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const command = target ? [target] : [process.execPath, join(ROOT, 'bin', 'swai.js')];

const server = await startMockOpenAI();
const workspace = mkdtempSync(join(tmpdir(), 'swai-compat-smoke-'));
cpSync(join(ROOT, 'examples', 'demo'), workspace, { recursive: true });

let failures = 0;

/**
 * Runs the CLI as a child process. It must not be spawnSync: the mock server
 * lives in this process and would be blocked from answering.
 */
function step(title, args, expected, mustContain) {
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        NO_COLOR: '1',
        SWAI_COMPAT_BASE_URL: server.url,
        SWAI_COMPAT_MODEL: MOCK_MODEL,
      },
      // A global install on Windows is a .cmd shim, which needs a shell.
      shell: process.platform === 'win32' && Boolean(target),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const ok = code === expected && stdout.includes(mustContain);
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${title} (exit ${code}, expected ${expected})`);
      if (!ok) {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
      }
      done();
    });
  });
}

console.log(`mock server at ${server.url}, CLI: ${command.join(' ')}`);

await step(
  'review gates on the finding',
  ['--provider', 'compat', '--no-color', 'review', '--patch-file', 'cart.diff'],
  5,
  'Mock finding on the first added line of src/cart.js',
);
await step(
  'review as JSON',
  ['--provider', 'compat', 'review', '--patch-file', 'cart.diff', '--json', '--fail-on', 'never'],
  0,
  '"comments"',
);
await step(
  'explain streams the response',
  ['--provider', 'compat', '--no-color', 'explain', 'src/cart.js', '--detail', 'brief'],
  0,
  'Mock response from the OpenAI-compatible test server.',
);

const requests = server.requests.length;
await server.close();
rmSync(workspace, { recursive: true, force: true });

if (requests < 3) {
  failures++;
  console.log(`FAIL expected at least 3 requests at the mock server, saw ${requests}`);
}
if (failures > 0) {
  console.error(`\n${failures} compat smoke check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll compat smoke checks passed (${requests} requests served by the mock server).`);
