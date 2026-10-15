#!/usr/bin/env node
/**
 * Process wrapper.
 *
 * Everything testable lives in `runCli`, which returns an exit code rather
 * than calling `process.exit`. This file owns the parts that only make sense
 * against a real process: signal handling and the exit itself.
 */
import { runCli } from '../dist/cli/run.js';

const controller = new AbortController();

const interrupt = () => {
  controller.abort();
  // A second Ctrl-C stops waiting for a graceful unwind.
  process.once('SIGINT', () => process.exit(130));
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', () => controller.abort());

try {
  const code = await runCli({ argv: process.argv.slice(2), signal: controller.signal });
  process.exitCode = code;
} catch (error) {
  // runCli handles its own errors; anything reaching here is a bug in the CLI
  // itself, so print the stack rather than a tidy message.
  console.error(error);
  process.exitCode = 1;
}
