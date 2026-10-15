import type { LogLevel } from '../kernel/logger.js';
import type { PriceTable } from '../providers/pricing.js';

export type Severity = 'info' | 'warning' | 'error';
export const SEVERITIES: readonly Severity[] = ['info', 'warning', 'error'];

/** Severity at or above which `review` exits with ExitCode.Findings. */
export type FailOn = Severity | 'never';

export interface BudgetConfig {
  /** Abort before a request that would push spend past this many US dollars. */
  maxUsd?: number;
  /** Abort before a request that would push total tokens past this. */
  maxTokens?: number;
}

export interface ReviewConfig {
  failOn: FailOn;
  /** Hard cap on comments reported, applied after plugin hooks. */
  maxComments: number;
  /** Paths excluded from review, as glob-ish suffix/prefix patterns. */
  exclude: string[];
}

export interface ResolvedConfig {
  provider: string;
  model?: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
  json: boolean;
  logLevel: LogLevel;
  /** Module specifiers or paths of plugins to load, in order. */
  plugins: string[];
  /** Built-in plugins to skip, by name. */
  disablePlugins: string[];
  /** Per-plugin settings, keyed by plugin name. */
  pluginConfig: Record<string, unknown>;
  /** Per-provider settings, keyed by provider id. See `providers/compatible.ts`. */
  providerConfig: Record<string, unknown>;
  review: ReviewConfig;
  budget: BudgetConfig;
  /** Overrides merged over DEFAULT_PRICING. */
  pricing: PriceTable;
  /** Directory searched for prompt templates before the packaged ones. */
  templatesDir?: string;
  /** Absolute path of the config file that was loaded, if any. */
  configPath?: string;
  cwd: string;
}

/** The shape accepted in a config file — every field optional. */
export type FileConfig = Partial<
  Omit<ResolvedConfig, 'review' | 'budget' | 'configPath' | 'cwd'>
> & {
  review?: Partial<ReviewConfig>;
  budget?: Partial<BudgetConfig>;
};

export const CONFIG_FILE_NAMES = [
  'swai.config.json',
  '.swairc.json',
  '.swairc',
] as const;

export const DEFAULT_CONFIG: Omit<ResolvedConfig, 'cwd'> = {
  provider: 'openai',
  maxTokens: 8192,
  timeoutMs: 120_000,
  stream: true,
  json: false,
  logLevel: 'info',
  plugins: [],
  disablePlugins: [],
  pluginConfig: {},
  providerConfig: {},
  review: {
    failOn: 'error',
    maxComments: 50,
    exclude: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'dist/', 'coverage/'],
  },
  budget: {},
  pricing: {},
};
