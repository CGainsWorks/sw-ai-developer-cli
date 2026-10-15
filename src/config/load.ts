import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { ConfigError } from '../kernel/errors.js';
import { isLogLevel } from '../kernel/logger.js';
import {
  CONFIG_FILE_NAMES,
  DEFAULT_CONFIG,
  SEVERITIES,
  type FailOn,
  type FileConfig,
  type ResolvedConfig,
} from './types.js';

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit `--config` path. Missing file is an error, unlike discovery. */
  configPath?: string;
  /** Skip file discovery entirely (`--no-config`). */
  noConfigFile?: boolean;
  /** Flags parsed from argv; highest precedence. */
  overrides?: Partial<ResolvedConfig>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Precedence, lowest to highest: defaults, config file, environment, CLI flags.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  let fileConfig: FileConfig = {};
  let configPath: string | undefined;

  if (options.configPath) {
    configPath = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
    if (!existsSync(configPath)) {
      throw new ConfigError(`Config file not found: ${configPath}`, {
        hint: 'Check the --config path, or omit --config to search upward for swai.config.json.',
      });
    }
    fileConfig = await readConfigFile(configPath);
  } else if (!options.noConfigFile) {
    const found = findConfigFile(cwd);
    if (found) {
      configPath = found;
      fileConfig = await readConfigFile(found);
    }
  }

  const envConfig = readEnvConfig(env);

  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...stripUndefined(fileConfig),
    ...stripUndefined(envConfig),
    ...stripUndefined(options.overrides ?? {}),
    review: {
      ...DEFAULT_CONFIG.review,
      ...stripUndefined(fileConfig.review ?? {}),
      ...stripUndefined(options.overrides?.review ?? {}),
    },
    budget: {
      ...DEFAULT_CONFIG.budget,
      ...stripUndefined(fileConfig.budget ?? {}),
      ...stripUndefined(envConfig.budget ?? {}),
      ...stripUndefined(options.overrides?.budget ?? {}),
    },
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...(fileConfig.pricing ?? {}),
      ...(options.overrides?.pricing ?? {}),
    },
    pluginConfig: {
      ...DEFAULT_CONFIG.pluginConfig,
      ...(fileConfig.pluginConfig ?? {}),
      ...(options.overrides?.pluginConfig ?? {}),
    },
    providerConfig: {
      ...DEFAULT_CONFIG.providerConfig,
      ...(fileConfig.providerConfig ?? {}),
      ...(options.overrides?.providerConfig ?? {}),
    },
    // Plugin lists concatenate rather than replace: a --plugin flag adds to
    // whatever the config file asked for instead of silently dropping it.
    plugins: dedupe([
      ...(fileConfig.plugins ?? []),
      ...(envConfig.plugins ?? []),
      ...(options.overrides?.plugins ?? []),
    ]),
    disablePlugins: dedupe([
      ...(fileConfig.disablePlugins ?? []),
      ...(options.overrides?.disablePlugins ?? []),
    ]),
    cwd,
  };

  if (configPath) merged.configPath = configPath;

  // Plugin paths in a config file are relative to that file, not to cwd.
  if (configPath) {
    const base = dirname(configPath);
    merged.plugins = merged.plugins.map((spec) => resolvePluginSpec(spec, base));
    if (merged.templatesDir && !isAbsolute(merged.templatesDir)) {
      merged.templatesDir = resolve(base, merged.templatesDir);
    }
  }

  validate(merged);
  return merged;
}

function resolvePluginSpec(spec: string, base: string): string {
  return spec.startsWith('.') ? resolve(base, spec) : spec;
}

export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  // Walk up to the filesystem root. `dirname('/') === '/'` terminates it.
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readConfigFile(path: string): Promise<FileConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Could not read config file: ${path}`, { cause: err });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return parsed as FileConfig;
  } catch (err) {
    throw new ConfigError(
      `Invalid JSON in config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { hint: 'The config file must contain a single JSON object.' },
    );
  }
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<ResolvedConfig> {
  const out: Partial<ResolvedConfig> = {};
  if (env.SWAI_PROVIDER) out.provider = env.SWAI_PROVIDER;
  if (env.SWAI_MODEL) out.model = env.SWAI_MODEL;
  if (env.SWAI_LOG_LEVEL && isLogLevel(env.SWAI_LOG_LEVEL)) out.logLevel = env.SWAI_LOG_LEVEL;
  if (env.SWAI_MAX_TOKENS) {
    const n = Number(env.SWAI_MAX_TOKENS);
    if (Number.isFinite(n)) out.maxTokens = n;
  }
  if (env.SWAI_PLUGINS) {
    out.plugins = env.SWAI_PLUGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (env.SWAI_MAX_USD) {
    const n = Number(env.SWAI_MAX_USD);
    if (Number.isFinite(n)) out.budget = { maxUsd: n };
  }
  // CI is the common non-interactive case: default to machine-readable output
  // unless something more specific has already asked otherwise.
  if (env.SWAI_JSON === '1' || env.SWAI_JSON === 'true') out.json = true;
  return out;
}

function validate(config: ResolvedConfig): void {
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new ConfigError(`maxTokens must be a positive integer, got ${String(config.maxTokens)}`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new ConfigError(`timeoutMs must be a positive number, got ${String(config.timeoutMs)}`);
  }
  if (!isFailOn(config.review.failOn)) {
    throw new ConfigError(
      `review.failOn must be one of ${[...SEVERITIES, 'never'].join(', ')}, got "${String(
        config.review.failOn,
      )}"`,
    );
  }
  if (!Number.isInteger(config.review.maxComments) || config.review.maxComments < 0) {
    throw new ConfigError('review.maxComments must be a non-negative integer');
  }
  if (config.budget.maxUsd !== undefined && config.budget.maxUsd <= 0) {
    throw new ConfigError('budget.maxUsd must be greater than zero');
  }
  if (config.budget.maxTokens !== undefined && config.budget.maxTokens <= 0) {
    throw new ConfigError('budget.maxTokens must be greater than zero');
  }
  if (!isLogLevel(config.logLevel)) {
    throw new ConfigError(`Unknown logLevel "${String(config.logLevel)}"`);
  }
}

export function isFailOn(value: unknown): value is FailOn {
  return value === 'never' || (typeof value === 'string' && SEVERITIES.includes(value as never));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
