/**
 * The public plugin API.
 *
 * This module is the package's `sw-ai-developer-cli/plugin` entry point and is
 * the *only* surface third-party plugins should import. Everything the three
 * built-in commands use is defined here — `generate`, `review` and `explain`
 * are themselves plugins built against this file, which is what keeps the API
 * honest rather than decorative.
 *
 * See docs/PLUGIN_GUIDE.md for a walkthrough.
 */

import type { ExitCode } from '../kernel/exit-codes.js';
import type { Logger } from '../kernel/logger.js';
import type { OutputRenderer } from '../output/renderer.js';
import type { UsageTracker } from '../kernel/usage.js';
import type { ResolvedConfig, Severity } from '../config/types.js';
import type { FileDiff } from '../git/diff.js';
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderFactory,
} from '../providers/types.js';

export type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderFactory,
  FileDiff,
  ResolvedConfig,
  Severity,
  OutputRenderer,
  Logger,
  UsageTracker,
};

/**
 * Bumped only on a breaking change to this file. The loader refuses a plugin
 * declaring a different major version rather than letting it half-work.
 */
export const PLUGIN_API_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * Long option names the CLI itself claims.
 *
 * Global flags are extracted from argv before a command's own parser runs, so
 * a plugin option with one of these names would never receive a value — the
 * flag would be silently swallowed. The loader rejects such a plugin rather
 * than letting it half-work.
 */
export const RESERVED_OPTION_NAMES: readonly string[] = [
  'color',
  'config',
  'cwd',
  'disable-plugin',
  'help',
  'json',
  'log-level',
  'max-tokens',
  'max-usd',
  'model',
  'no-color',
  'no-config',
  'no-stream',
  'plugin',
  'provider',
  'quiet',
  'stream',
  'token-budget',
  'verbose',
  'version',
];

/** Short flags the CLI itself claims. */
export const RESERVED_OPTION_SHORTS: readonly string[] = ['h', 'V'];

export interface OptionSpec {
  /** Long flag name, without dashes: `fail-on` becomes `--fail-on`. */
  name: string;
  /** Single-character short flag, without the dash. */
  short?: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'string[]';
  default?: string | boolean | number | string[];
  /** Restrict a string option to a fixed set. Validated before the command runs. */
  choices?: readonly string[];
  required?: boolean;
}

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Collects all remaining positionals into an array. Must be the last arg. */
  variadic?: boolean;
}

export interface CommandResult {
  exitCode: ExitCode;
  /** Emitted verbatim as the document in `--json` mode. */
  data?: unknown;
  /** One-line human summary, printed to stderr at info level. */
  summary?: string;
}

export interface CommandSpec {
  name: string;
  description: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  /** Extra lines appended to `--help`. */
  examples?: string[];
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}

/* ------------------------------------------------------------------ *
 * Command context
 * ------------------------------------------------------------------ */

/** What a plugin contributed, as seen from the outside. */
export interface PluginInfo {
  name: string;
  version?: string;
  description?: string;
  builtin: boolean;
  commands: string[];
  providers: string[];
  hooks: HookName[];
}

export interface CommandContext {
  /** Name of the command being run. */
  readonly command: string;
  /** Positional arguments, in declaration order. */
  readonly args: Record<string, string | string[] | undefined>;
  readonly options: Record<string, unknown>;
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly out: OutputRenderer;
  readonly usage: UsageTracker;
  readonly provider: Provider;
  readonly hooks: HookDispatcher;
  /** Every loaded plugin, so a plugin can introspect the running CLI. */
  readonly plugins: readonly PluginInfo[];
  readonly cwd: string;
  readonly signal: AbortSignal;

  /**
   * Non-streaming model call. Runs `beforeModelCall` / `afterModelCall`, and
   * records tokens and cost against the budget. Prefer this over calling
   * `ctx.provider` directly — a raw provider call bypasses hooks and
   * accounting.
   */
  complete(request: CompletionRequest): Promise<CompletionResult>;

  /**
   * Streaming model call. Text is written to the renderer as it arrives
   * (suppressed in `--json` mode) and `onText` is invoked per chunk.
   */
  streamText(
    request: CompletionRequest,
    onText?: (chunk: string) => void,
  ): Promise<CompletionResult>;

  /** Reads a prompt template by name, applying `{{placeholder}}` substitution. */
  renderTemplate(name: string, vars: Record<string, string>): Promise<string>;

  /** Settings for the calling plugin, from `pluginConfig[<plugin name>]`. */
  pluginConfig<T = Record<string, unknown>>(pluginName: string): T | undefined;
}

/* ------------------------------------------------------------------ *
 * Review comments
 * ------------------------------------------------------------------ */

export interface ReviewComment {
  file: string;
  /** Line number in the post-change file. 0 means file-level. */
  line: number;
  severity: Severity;
  /** Short slug, e.g. `correctness`, `security`, `style`. */
  category: string;
  message: string;
  /** Optional replacement snippet for the cited line(s). */
  suggestion?: string;
  /** Which plugin produced it. Set by the kernel; plugins may leave it unset. */
  source?: string;
}

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

export interface BeforeCommandEvent {
  command: string;
  options: Record<string, unknown>;
}

export interface AfterCommandEvent {
  command: string;
  result: CommandResult;
}

export interface ModelCallEvent {
  command: string;
  request: CompletionRequest;
}

export interface AfterModelCallEvent extends ModelCallEvent {
  result: CompletionResult;
}

export interface ReviewCommentsEvent {
  comments: ReviewComment[];
  diff: FileDiff[];
  config: ResolvedConfig;
}

export interface BeforePatchEvent {
  changes: PatchChange[];
  dryRun: boolean;
}

/**
 * Transform hooks may return a replacement value or nothing. Returning
 * `undefined` leaves the value untouched, which is what lets a hook be a pure
 * observer without having to echo its input back.
 */
export interface PluginHooks {
  beforeCommand?(event: BeforeCommandEvent): void | Promise<void>;
  afterCommand?(event: AfterCommandEvent): void | Promise<void>;
  beforeModelCall?(
    event: ModelCallEvent,
  ): void | CompletionRequest | Promise<void | CompletionRequest>;
  afterModelCall?(event: AfterModelCallEvent): void | Promise<void>;
  reviewComments?(
    event: ReviewCommentsEvent,
  ): void | ReviewComment[] | Promise<void | ReviewComment[]>;
  beforePatch?(event: BeforePatchEvent): void | PatchChange[] | Promise<void | PatchChange[]>;
}

export type HookName = keyof PluginHooks;

export interface HookDispatcher {
  beforeCommand(event: BeforeCommandEvent): Promise<void>;
  afterCommand(event: AfterCommandEvent): Promise<void>;
  beforeModelCall(event: ModelCallEvent): Promise<CompletionRequest>;
  afterModelCall(event: AfterModelCallEvent): Promise<void>;
  reviewComments(event: ReviewCommentsEvent): Promise<ReviewComment[]>;
  beforePatch(event: BeforePatchEvent): Promise<PatchChange[]>;
}

/* ------------------------------------------------------------------ *
 * Patching
 * ------------------------------------------------------------------ */

export interface PatchChange {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  /** Final content. Undefined for a delete. */
  contents?: string;
  /** Content before the change. Undefined for a create. */
  previous?: string;
}

/* ------------------------------------------------------------------ *
 * Plugin definition
 * ------------------------------------------------------------------ */

export interface SetupContext {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  /** This plugin's slice of `pluginConfig`. */
  readonly settings: Record<string, unknown>;
  registerCommand(command: CommandSpec): void;
  registerProvider(factory: ProviderFactory): void;
  addHooks(hooks: PluginHooks): void;
}

export interface Plugin {
  /** Unique. Used by `--disable-plugin` and to key `pluginConfig`. */
  name: string;
  /** Must equal PLUGIN_API_VERSION. */
  apiVersion: number;
  version?: string;
  description?: string;
  commands?: CommandSpec[];
  providers?: ProviderFactory[];
  hooks?: PluginHooks;
  /**
   * Runs after static registration, before any command executes. Use it for
   * conditional registration or for reading `settings`.
   */
  setup?(ctx: SetupContext): void | Promise<void>;
}

/** Identity helper that gives plugin authors type-checking without a cast. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/* ------------------------------------------------------------------ *
 * Option helpers, re-exported for plugin authors
 * ------------------------------------------------------------------ */

export function getString(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

export function getBoolean(options: Record<string, unknown>, key: string): boolean {
  return options[key] === true;
}

export function getNumber(
  options: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = options[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function getStringArray(options: Record<string, unknown>, key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}
