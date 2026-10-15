import { readFileSync } from 'node:fs';

import { parseCommand, parseGlobals } from './args.js';
import { formatCommandHelp, formatRootHelp } from './help.js';
import { loadConfig } from '../config/load.js';
import { CliError, toCliError } from '../kernel/errors.js';
import { ExitCode } from '../kernel/exit-codes.js';
import { createLogger, isLogLevel } from '../kernel/logger.js';
import { Kernel } from '../kernel/kernel.js';
import { formatUsageSummary } from '../kernel/usage.js';
import { createRenderer } from '../output/renderer.js';
import type { Plugin } from '../plugins/api.js';
import type { Provider } from '../providers/types.js';
import type { ResolvedConfig } from '../config/types.js';

export interface RunCliOptions {
  /** argv without the node binary and script path. */
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (chunk: string) => void;
  stderr?: (line: string) => void;
  signal?: AbortSignal;
  /** Test seams. */
  builtins?: readonly Plugin[];
  importModule?: (specifier: string) => Promise<unknown>;
  provider?: Provider;
}

export function readVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(url, 'utf8'));
    if (pkg && typeof pkg === 'object' && typeof (pkg as { version?: unknown }).version === 'string') {
      return (pkg as { version: string }).version;
    }
  } catch {
    /* fall through */
  }
  return '0.0.0-development';
}

/**
 * Runs the CLI and returns the exit code. Never calls `process.exit`, so the
 * whole surface is testable in-process — the bin wrapper owns exiting.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const stderr = options.stderr ?? ((line: string) => void process.stderr.write(line + '\n'));

  let globals: ReturnType<typeof parseGlobals>['globals'] | undefined;

  try {
    const parsed = parseGlobals(options.argv);
    globals = parsed.globals;
    const rest = parsed.rest;

    if (globals.version) {
      stdout(readVersion() + '\n');
      return ExitCode.Ok;
    }

    const config = await buildConfig(globals, options);

    const logger = createLogger({ level: config.logLevel, write: stderr });
    const renderer = createRenderer({
      json: config.json,
      write: stdout,
      ...(globals.color !== undefined ? { color: globals.color } : {}),
    });

    const kernelOptions: Parameters<typeof Kernel.create>[0] = {
      config,
      logger,
      renderer,
    };
    if (options.builtins) kernelOptions.builtins = options.builtins;
    if (options.importModule) kernelOptions.importModule = options.importModule;
    if (options.provider) kernelOptions.provider = options.provider;
    if (options.signal) kernelOptions.signal = options.signal;

    const kernel = await Kernel.create(kernelOptions);

    const commandName = rest.find((token) => !token.startsWith('-'));

    if (!commandName) {
      stdout(formatRootHelp(kernel.registry.listCommands(), readVersion()) + '\n');
      // No command is a usage problem unless help was asked for explicitly.
      return globals.help ? ExitCode.Ok : ExitCode.Usage;
    }

    const command = kernel.registry.getCommand(commandName);
    if (!command) {
      stderr(`error: unknown command "${commandName}"`);
      const available = kernel.registry
        .listCommands()
        .map((c) => c.name)
        .sort();
      const suggestion = closestMatch(commandName, available);
      if (suggestion) stderr(`did you mean "${suggestion}"?`);
      stderr(`available commands: ${available.join(', ')}`);
      return ExitCode.Usage;
    }

    if (globals.help) {
      stdout(formatCommandHelp(command) + '\n');
      return ExitCode.Ok;
    }

    // Drop exactly the first occurrence of the command name, so a positional
    // that repeats it (`swai explain explain.ts`) still reaches the command.
    const invocation = parseCommand(command, dropFirst(rest, commandName));
    const result = await kernel.run(commandName, invocation);

    const usage = kernel.usage.summary();
    if (usage.calls > 0) {
      logger.info(formatUsageSummary(usage));
    }
    if (result.summary) logger.debug(`result: ${result.summary}`);

    return result.exitCode;
  } catch (err) {
    const cliError = toCliError(err);
    stderr(`error: ${cliError.message}`);
    if (cliError.hint) stderr(`hint: ${cliError.hint}`);
    if (globals?.logLevel === 'debug' && cliError.cause instanceof Error) {
      stderr(cliError.cause.stack ?? String(cliError.cause));
    }
    return cliError.exitCode;
  }
}

async function buildConfig(
  globals: ReturnType<typeof parseGlobals>['globals'],
  options: RunCliOptions,
): Promise<ResolvedConfig> {
  const overrides: Partial<ResolvedConfig> = {};
  if (globals.provider) overrides.provider = globals.provider;
  if (globals.model) overrides.model = globals.model;
  if (globals.maxTokens !== undefined) overrides.maxTokens = globals.maxTokens;
  if (globals.json) overrides.json = true;
  if (globals.stream !== undefined) overrides.stream = globals.stream;
  if (globals.plugins.length) overrides.plugins = globals.plugins;
  if (globals.disablePlugins.length) overrides.disablePlugins = globals.disablePlugins;
  if (globals.logLevel) {
    if (!isLogLevel(globals.logLevel)) {
      throw new CliError(`Unknown --log-level "${globals.logLevel}"`, {
        exitCode: ExitCode.Usage,
        hint: 'Use one of: silent, error, warn, info, debug.',
      });
    }
    overrides.logLevel = globals.logLevel;
  }
  if (globals.maxUsd !== undefined || globals.tokenBudget !== undefined) {
    overrides.budget = {
      ...(globals.maxUsd !== undefined ? { maxUsd: globals.maxUsd } : {}),
      ...(globals.tokenBudget !== undefined ? { maxTokens: globals.tokenBudget } : {}),
    };
  }

  const loadOptions: Parameters<typeof loadConfig>[0] = {
    cwd: globals.cwd ?? options.cwd ?? process.cwd(),
    overrides,
    env: options.env ?? process.env,
    noConfigFile: globals.noConfigFile,
  };
  if (globals.configPath) loadOptions.configPath = globals.configPath;

  return loadConfig(loadOptions);
}

function dropFirst(tokens: string[], value: string): string[] {
  const index = tokens.indexOf(value);
  if (index < 0) return tokens;
  return [...tokens.slice(0, index), ...tokens.slice(index + 1)];
}

/** Levenshtein-based "did you mean", only when the guess is close enough. */
export function closestMatch(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }

  return previous[cols - 1] as number;
}
