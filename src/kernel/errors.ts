import { ExitCode } from './exit-codes.js';

export interface CliErrorOptions {
  exitCode?: ExitCode;
  /** Actionable next step, printed under the error message. */
  hint?: string;
  cause?: unknown;
}

/**
 * An error that carries the process exit code it should produce.
 *
 * Anything thrown that is not a CliError becomes ExitCode.Error, and its stack
 * is only printed at debug log level.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? ExitCode.Error;
    this.hint = options.hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.Usage });
    this.name = 'UsageError';
  }
}

export class ConfigError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.Config });
    this.name = 'ConfigError';
  }
}

export class ProviderError extends CliError {
  readonly provider: string;

  constructor(provider: string, message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.Provider });
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

export class PluginError extends CliError {
  readonly plugin: string;

  constructor(plugin: string, message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.PluginError });
    this.name = 'PluginError';
    this.plugin = plugin;
  }
}

export class BudgetExceededError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.BudgetExceeded });
    this.name = 'BudgetExceededError';
  }
}

export class PatchError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, 'exitCode'> = {}) {
    super(message, { ...options, exitCode: ExitCode.PatchFailed });
    this.name = 'PatchError';
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) return new CliError(err.message, { cause: err });
  return new CliError(String(err));
}
