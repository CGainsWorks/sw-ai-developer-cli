import { CliError, PluginError, ProviderError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { HookBus } from './hooks.js';
import { UsageTracker } from './usage.js';
import { createRenderer, type OutputRenderer } from '../output/renderer.js';
import { TemplateLoader } from '../prompts/templates.js';
import { Registry } from '../plugins/registry.js';
import { assertValidPlugin, loadPlugin } from '../plugins/loader.js';
import { BUILTIN_PLUGINS } from '../plugins/builtin/index.js';
import { drainStream, type CompletionRequest, type CompletionResult, type Provider } from '../providers/types.js';
import type { ResolvedConfig } from '../config/types.js';
import type {
  CommandContext,
  CommandResult,
  CommandSpec,
  HookName,
  Plugin,
  PluginInfo,
  SetupContext,
} from '../plugins/api.js';

export interface KernelOptions {
  config: ResolvedConfig;
  logger?: Logger;
  renderer?: OutputRenderer;
  /** Overrides the default built-in plugin set. Used by tests. */
  builtins?: readonly Plugin[];
  /** Injectable dynamic import, for tests. */
  importModule?: (specifier: string) => Promise<unknown>;
  /** Pre-built provider, bypassing factory resolution. Used by tests. */
  provider?: Provider;
  signal?: AbortSignal;
}

export interface ParsedInvocation {
  args: Record<string, string | string[] | undefined>;
  options: Record<string, unknown>;
}

/**
 * The plugin host.
 *
 * The kernel owns nothing user-facing: every command, and every provider, is
 * contributed by a plugin. Its whole job is to load plugins, resolve a
 * provider, and give a command a context that routes model calls through the
 * hook chain and the usage tracker.
 */
export class Kernel {
  readonly registry: Registry;
  readonly hooks: HookBus;
  readonly usage: UsageTracker;
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly out: OutputRenderer;

  private readonly templates: TemplateLoader;
  private readonly signal: AbortSignal;
  private readonly injectedProvider: Provider | undefined;
  private resolvedProvider: Provider | undefined;
  private pluginInfos: PluginInfo[] = [];

  private constructor(options: KernelOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger({ level: options.config.logLevel });
    this.out = options.renderer ?? createRenderer({ json: options.config.json });
    this.registry = new Registry();
    this.hooks = new HookBus(this.logger);
    this.usage = new UsageTracker({
      budget: options.config.budget,
      pricing: options.config.pricing,
    });
    this.templates = new TemplateLoader({
      ...(options.config.templatesDir ? { templatesDir: options.config.templatesDir } : {}),
      cwd: options.config.cwd,
    });
    this.signal = options.signal ?? new AbortController().signal;
    this.injectedProvider = options.provider;
  }

  static async create(options: KernelOptions): Promise<Kernel> {
    const kernel = new Kernel(options);
    await kernel.loadPlugins(options);
    return kernel;
  }

  private async loadPlugins(options: KernelOptions): Promise<void> {
    const disabled = new Set(this.config.disablePlugins);
    const plugins: Plugin[] = [];

    for (const plugin of options.builtins ?? BUILTIN_PLUGINS) {
      // Built-ins are validated on the same terms as third-party plugins.
      // They are ordinary plugins, so an invalid one should fail as loudly.
      assertValidPlugin(plugin, `builtin:${plugin.name}`);
      if (disabled.has(plugin.name)) {
        this.logger.debug(`built-in plugin "${plugin.name}" disabled`);
        continue;
      }
      plugins.push(plugin);
    }

    for (const specifier of this.config.plugins) {
      const loadOptions: Parameters<typeof loadPlugin>[1] = { cwd: this.config.cwd };
      if (options.importModule) loadOptions.importModule = options.importModule;
      const plugin = await loadPlugin(specifier, loadOptions);
      if (disabled.has(plugin.name)) {
        this.logger.debug(`plugin "${plugin.name}" from ${specifier} disabled`);
        continue;
      }
      this.logger.debug(`loaded plugin "${plugin.name}" from ${specifier}`);
      plugins.push(plugin);
    }

    // Two passes: register everything statically first, so a plugin's setup()
    // can see commands and providers contributed by plugins after it. Hooks
    // carry their plugin's index so the two passes still produce a single
    // load-order hook chain (see HookBus.add).
    plugins.forEach((plugin, index) => {
      this.registry.addPlugin(plugin);
      for (const command of plugin.commands ?? []) {
        this.registry.registerCommand(plugin.name, command);
      }
      for (const provider of plugin.providers ?? []) {
        this.registry.registerProvider(plugin.name, provider);
      }
      if (plugin.hooks) this.hooks.add(plugin.name, plugin.hooks, index);
    });

    const builtinNames = new Set((options.builtins ?? BUILTIN_PLUGINS).map((p) => p.name));

    for (const [index, plugin] of plugins.entries()) {
      if (!plugin.setup) continue;
      const setupContext: SetupContext = {
        config: this.config,
        logger: this.logger.child(plugin.name),
        settings: this.settingsFor(plugin.name),
        registerCommand: (command: CommandSpec) =>
          this.registry.registerCommand(plugin.name, command),
        registerProvider: (factory) => this.registry.registerProvider(plugin.name, factory),
        addHooks: (hooks) => this.hooks.add(plugin.name, hooks, index),
      };
      try {
        await plugin.setup(setupContext);
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new PluginError(plugin.name, `Plugin "${plugin.name}" failed during setup`, {
          cause: err,
        });
      }
    }

    // Built after setup(), so conditionally registered commands are included.
    const commands = this.registry.commandsByPlugin();
    const providers = this.registry.providersByPlugin();
    const hookNames = this.hooks.hookNamesByPlugin();

    this.pluginInfos = plugins.map((plugin) => {
      const info: PluginInfo = {
        name: plugin.name,
        builtin: builtinNames.has(plugin.name),
        commands: commands.get(plugin.name) ?? [],
        providers: providers.get(plugin.name) ?? [],
        hooks: hookNames.get(plugin.name) ?? [],
      };
      if (plugin.version) info.version = plugin.version;
      if (plugin.description) info.description = plugin.description;
      return info;
    });
  }

  listPluginInfo(): readonly PluginInfo[] {
    return this.pluginInfos;
  }

  private providerSettings(providerId: string): Record<string, unknown> {
    return asRecord(this.config.providerConfig[providerId]);
  }

  private settingsFor(pluginName: string): Record<string, unknown> {
    return asRecord(this.config.pluginConfig[pluginName]);
  }

  provider(): Provider {
    if (this.injectedProvider) return this.injectedProvider;
    if (this.resolvedProvider) return this.resolvedProvider;

    const factory = this.registry.getProvider(this.config.provider);
    if (!factory) {
      const known = this.registry.listProviders().map((p) => p.id);
      throw new ProviderError(this.config.provider, `Unknown provider "${this.config.provider}"`, {
        hint: known.length ? `Available providers: ${known.join(', ')}.` : undefined,
      });
    }

    this.resolvedProvider = factory.create({
      ...(this.config.model ? { model: this.config.model } : {}),
      maxTokens: this.config.maxTokens,
      timeoutMs: this.config.timeoutMs,
      settings: this.providerSettings(factory.id),
    });
    return this.resolvedProvider;
  }

  async run(commandName: string, invocation: ParsedInvocation): Promise<CommandResult> {
    const command = this.registry.getCommand(commandName);
    if (!command) {
      throw new CliError(`Unknown command "${commandName}"`, { exitCode: 2 });
    }

    const ctx = this.createContext(command, invocation);

    await this.hooks.beforeCommand({ command: commandName, options: invocation.options });
    const result = await command.run(ctx);
    await this.hooks.afterCommand({ command: commandName, result });

    if (this.out.isJson) {
      this.out.json({
        command: commandName,
        exitCode: result.exitCode,
        ...(result.data !== undefined && typeof result.data === 'object' && result.data !== null
          ? (result.data as Record<string, unknown>)
          : { data: result.data }),
        usage: this.usage.summary(),
      });
    }

    return result;
  }

  private createContext(command: CommandSpec, invocation: ParsedInvocation): CommandContext {
    const kernel = this;

    const complete = async (request: CompletionRequest): Promise<CompletionResult> => {
      const finalRequest = await kernel.hooks.beforeModelCall({
        command: command.name,
        request,
      });
      const provider = kernel.provider();
      const result = await provider.complete(finalRequest);
      kernel.usage.record({
        provider: provider.id,
        command: command.name,
        result,
        price: provider.price,
      });
      await kernel.hooks.afterModelCall({
        command: command.name,
        request: finalRequest,
        result,
      });
      return result;
    };

    const streamText = async (
      request: CompletionRequest,
      onText?: (chunk: string) => void,
    ): Promise<CompletionResult> => {
      const finalRequest = await kernel.hooks.beforeModelCall({
        command: command.name,
        request,
      });
      const provider = kernel.provider();
      const result = await drainStream(provider.stream(finalRequest), (chunk) => {
        kernel.out.text(chunk);
        onText?.(chunk);
      });
      kernel.usage.record({
        provider: provider.id,
        command: command.name,
        result,
        price: provider.price,
      });
      await kernel.hooks.afterModelCall({
        command: command.name,
        request: finalRequest,
        result,
      });
      return result;
    };

    const ctx: Omit<CommandContext, 'provider'> = {
      command: command.name,
      args: invocation.args,
      options: invocation.options,
      config: this.config,
      logger: this.logger,
      out: this.out,
      usage: this.usage,
      hooks: this.hooks,
      plugins: this.pluginInfos,
      cwd: this.config.cwd,
      signal: this.signal,
      complete,
      streamText,
      renderTemplate: (name, vars) => this.templates.render(name, vars),
      pluginConfig: <T>(pluginName: string): T | undefined => {
        const raw = this.config.pluginConfig[pluginName];
        return raw === undefined ? undefined : (raw as T);
      },
    };

    // Lazy: `swai plugins` and `--help` must work without an API key, so the
    // provider is only constructed if a command actually reaches for it.
    Object.defineProperty(ctx, 'provider', {
      enumerable: true,
      get: () => kernel.provider(),
    });

    return ctx as CommandContext;
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}
