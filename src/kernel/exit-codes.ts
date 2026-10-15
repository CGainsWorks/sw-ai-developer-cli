/**
 * Process exit codes.
 *
 * These are part of the public contract: CI pipelines gate on them, so the
 * numbers must not be reshuffled between releases. New codes get appended.
 */
export const ExitCode = {
  /** Command completed, nothing to report. */
  Ok: 0,
  /** Unclassified runtime failure. */
  Error: 1,
  /** Bad invocation: unknown command, missing argument, bad flag value. */
  Usage: 2,
  /** Configuration could not be loaded, parsed, or validated. */
  Config: 3,
  /** The model provider failed: auth, rate limit, network, refusal. */
  Provider: 4,
  /** A review produced comments at or above the configured failure threshold. */
  Findings: 5,
  /** A patch could not be applied cleanly. */
  PatchFailed: 6,
  /** The run would exceed the configured token or cost budget. */
  BudgetExceeded: 7,
  /** A plugin failed to load, or registered a conflicting name. */
  PluginError: 8,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ExitCode).map(([name, code]) => [code, name]),
);

export function exitCodeName(code: number): string {
  return NAMES[code] ?? `Unknown(${code})`;
}
