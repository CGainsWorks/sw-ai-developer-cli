/**
 * Library entry point.
 *
 * Importing this package gives you the same kernel the CLI uses, so `swai` can
 * be embedded in a script or a larger tool without shelling out.
 */

export { runCli, readVersion, type RunCliOptions } from './cli/run.js';
export { Kernel, type KernelOptions, type ParsedInvocation } from './kernel/kernel.js';
export { Registry } from './plugins/registry.js';
export { HookBus } from './kernel/hooks.js';
export { UsageTracker, formatUsageSummary, type UsageSummary, type UsageRecord } from './kernel/usage.js';
export { loadConfig, findConfigFile } from './config/load.js';
export {
  DEFAULT_CONFIG,
  CONFIG_FILE_NAMES,
  SEVERITIES,
  type ResolvedConfig,
  type FileConfig,
  type Severity,
  type FailOn,
  type ReviewConfig,
  type BudgetConfig,
} from './config/types.js';
export { ExitCode, exitCodeName } from './kernel/exit-codes.js';
export {
  CliError,
  UsageError,
  ConfigError,
  ProviderError,
  PluginError,
  PatchError,
  BudgetExceededError,
  toCliError,
} from './kernel/errors.js';
export { createLogger, silentLogger, type Logger, type LogLevel } from './kernel/logger.js';
export { createRenderer, type OutputRenderer } from './output/renderer.js';
export { loadPlugin, assertValidPlugin } from './plugins/loader.js';
export { BUILTIN_PLUGINS } from './plugins/builtin/index.js';
export { TemplateLoader, renderTemplate, PACKAGED_TEMPLATES_DIR } from './prompts/templates.js';

export { parseUnifiedDiff, annotateForReview, diffStats, targetPath, changedLineNumbers } from './git/diff.js';
export type { FileDiff, Hunk, DiffLine } from './git/diff.js';
export { GitRepo } from './git/repo.js';
export { applyPatch, applyHunksToText, summarisePatch, safeResolve } from './output/patch.js';
export type { ApplyResult, ApplyOptions, PatchFs } from './output/patch.js';

export {
  DEFAULT_PRICING,
  computeCost,
  priceFor,
  formatUsd,
  costFor,
  type PriceTable,
  type ModelPrice,
} from './providers/pricing.js';
export { OpenAIProvider, openaiProviderFactory } from './providers/openai.js';
export {
  CompatibleProvider,
  compatProviderFactory,
  resolveCompatSettings,
  type CompatSettings,
} from './providers/compatible.js';
export { ChatCompletionsProvider } from './providers/chat-completions.js';
export {
  drainStream,
  UnsupportedStructuredOutput,
  type Provider,
  type ProviderFactory,
  type CompletionRequest,
  type CompletionResult,
  type StreamChunk,
  type TokenUsage,
} from './providers/types.js';

// The plugin-authoring surface, also published as `sw-ai-developer-cli/plugin`.
export * from './plugins/api.js';
