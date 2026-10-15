import { PluginError } from '../kernel/errors.js';
import type { CommandSpec, Plugin } from './api.js';
import type { ProviderFactory } from '../providers/types.js';

interface Owned<T> {
  plugin: string;
  value: T;
}

/**
 * Holds everything plugins contribute.
 *
 * Name collisions are hard errors rather than last-write-wins: two plugins
 * silently fighting over `review` is the kind of bug that only shows up in
 * someone else's CI.
 */
export class Registry {
  private readonly commands = new Map<string, Owned<CommandSpec>>();
  private readonly providers = new Map<string, Owned<ProviderFactory>>();
  private readonly plugins: Plugin[] = [];

  addPlugin(plugin: Plugin): void {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new PluginError(plugin.name, `Plugin "${plugin.name}" is already loaded`, {
        hint: 'Remove the duplicate entry from `plugins` in your config.',
      });
    }
    this.plugins.push(plugin);
  }

  registerCommand(pluginName: string, command: CommandSpec): void {
    const existing = this.commands.get(command.name);
    if (existing) {
      throw new PluginError(
        pluginName,
        `Command "${command.name}" is already registered by plugin "${existing.plugin}"`,
        { hint: `Disable one of them with --disable-plugin ${existing.plugin}.` },
      );
    }
    this.commands.set(command.name, { plugin: pluginName, value: command });
  }

  registerProvider(pluginName: string, factory: ProviderFactory): void {
    const existing = this.providers.get(factory.id);
    if (existing) {
      throw new PluginError(
        pluginName,
        `Provider "${factory.id}" is already registered by plugin "${existing.plugin}"`,
      );
    }
    this.providers.set(factory.id, { plugin: pluginName, value: factory });
  }

  getCommand(name: string): CommandSpec | undefined {
    return this.commands.get(name)?.value;
  }

  commandOwner(name: string): string | undefined {
    return this.commands.get(name)?.plugin;
  }

  getProvider(id: string): ProviderFactory | undefined {
    return this.providers.get(id)?.value;
  }

  listCommands(): CommandSpec[] {
    return [...this.commands.values()].map((c) => c.value);
  }

  listProviders(): ProviderFactory[] {
    return [...this.providers.values()].map((p) => p.value);
  }

  listPlugins(): readonly Plugin[] {
    return this.plugins;
  }

  /** Command names contributed by each plugin, including ones added in setup(). */
  commandsByPlugin(): Map<string, string[]> {
    return groupByOwner(this.commands, (name) => name);
  }

  providersByPlugin(): Map<string, string[]> {
    return groupByOwner(this.providers, (id) => id);
  }
}

function groupByOwner<T>(
  source: Map<string, Owned<T>>,
  label: (key: string) => string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, owned] of source) {
    const list = out.get(owned.plugin) ?? [];
    list.push(label(key));
    out.set(owned.plugin, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}
