import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PluginError } from '../kernel/errors.js';
import {
  PLUGIN_API_VERSION,
  RESERVED_OPTION_NAMES,
  RESERVED_OPTION_SHORTS,
  type Plugin,
} from './api.js';

export interface LoadPluginOptions {
  cwd: string;
  /** Injectable for tests; defaults to a real dynamic `import()`. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * Node's own dynamic import, hidden from bundlers and test-runner transforms.
 *
 * A plain `import(specifier)` is rewritten at build time by Vite, esbuild and
 * friends, which then try to resolve the plugin through *their* module graph.
 * That fails for anything outside the project root — most visibly on Windows,
 * where a plugin on a different drive than the project is unresolvable. A
 * plugin is user code chosen at runtime; it has to be Node that loads it.
 */
const nodeImport = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);

/**
 * Resolves a plugin specifier and returns its `Plugin`.
 *
 * Accepted forms:
 *   - `./plugins/my-plugin.js`  relative to cwd (or to the config file)
 *   - `/abs/path/plugin.js`
 *   - `swai-plugin-foo`         a package resolved from cwd's node_modules
 *
 * The module may export the plugin as `default` or as a named `plugin`, or
 * export a factory under either name that returns one.
 */
export async function loadPlugin(
  specifier: string,
  options: LoadPluginOptions,
): Promise<Plugin> {
  const url = resolveSpecifier(specifier, options.cwd);
  const importModule = options.importModule ?? nodeImport;

  let mod: unknown;
  try {
    mod = await importModule(url);
  } catch (err) {
    // Include the underlying reason. "Could not load plugin" on its own does
    // not distinguish a missing file from a syntax error in the plugin, which
    // are very different things to go and fix.
    const reason = err instanceof Error ? err.message : String(err);
    throw new PluginError(specifier, `Could not load plugin "${specifier}": ${reason}`, {
      cause: err,
      hint:
        'Check the path or that the package is installed. Plugins must be ESM ' +
        'or CommonJS modules resolvable from the working directory.',
    });
  }

  const plugin = await extractPlugin(mod, specifier);
  assertValidPlugin(plugin, specifier);
  return plugin;
}

/**
 * Resolves symlinks and Windows 8.3 short names before the path becomes a URL.
 *
 * Two reasons. A plugin reached by two spellings of the same path would
 * otherwise be imported twice as two separate module instances, with separate
 * state. And a short name like `C:\Users\RUNNER~1\...` percent-encodes to
 * `RUNNER%7E1`, which anything treating the URL as a plain path then fails to
 * find — the exact failure that broke plugin loading on Windows CI.
 *
 * A path that does not exist is passed through unchanged, so the import itself
 * reports the missing file rather than this helper masking it.
 */
function canonicalise(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function resolveSpecifier(specifier: string, cwd: string): string {
  if (specifier.startsWith('file://')) return specifier;

  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const abs = isAbsolute(specifier) ? specifier : resolve(cwd, specifier);
    return pathToFileURL(canonicalise(abs)).href;
  }

  // Bare specifier: resolve against the *project's* node_modules, not this
  // package's, so a user can install plugins next to their own project.
  try {
    const require = createRequire(pathToFileURL(resolve(cwd, 'package.json')).href);
    return pathToFileURL(require.resolve(specifier)).href;
  } catch {
    // Fall back to letting Node resolve it (works for globally linked or
    // self-referencing packages). A genuine failure surfaces at import time.
    return specifier;
  }
}

async function extractPlugin(mod: unknown, specifier: string): Promise<unknown> {
  if (mod === null || typeof mod !== 'object') {
    throw new PluginError(specifier, `Plugin "${specifier}" did not export a module object`);
  }
  const record = mod as Record<string, unknown>;
  const candidate = record.default ?? record.plugin;

  if (typeof candidate === 'function') {
    return (candidate as () => unknown)();
  }
  if (candidate === undefined) {
    throw new PluginError(
      specifier,
      `Plugin "${specifier}" has no default export and no named "plugin" export`,
      { hint: 'Export your plugin with `export default definePlugin({ ... })`.' },
    );
  }
  return candidate;
}

export function assertValidPlugin(value: unknown, specifier: string): asserts value is Plugin {
  if (value === null || typeof value !== 'object') {
    throw new PluginError(specifier, `Plugin "${specifier}" is not an object`);
  }
  const plugin = value as Partial<Plugin>;

  if (typeof plugin.name !== 'string' || plugin.name.trim() === '') {
    throw new PluginError(specifier, `Plugin "${specifier}" is missing a "name"`);
  }
  if (typeof plugin.apiVersion !== 'number') {
    throw new PluginError(
      specifier,
      `Plugin "${plugin.name}" is missing "apiVersion" (expected ${PLUGIN_API_VERSION})`,
    );
  }
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      specifier,
      `Plugin "${plugin.name}" targets plugin API v${plugin.apiVersion}, but this CLI implements v${PLUGIN_API_VERSION}`,
      { hint: 'Upgrade the plugin, or pin an older CLI version.' },
    );
  }

  for (const command of plugin.commands ?? []) {
    if (typeof command?.name !== 'string' || command.name.trim() === '') {
      throw new PluginError(specifier, `Plugin "${plugin.name}" declared a command with no name`);
    }
    if (typeof command.run !== 'function') {
      throw new PluginError(
        specifier,
        `Command "${command.name}" in plugin "${plugin.name}" has no run() function`,
      );
    }
    for (const option of command.options ?? []) {
      if (RESERVED_OPTION_NAMES.includes(option.name)) {
        throw new PluginError(
          specifier,
          `Command "${command.name}" in plugin "${plugin.name}" declares --${option.name}, which is a reserved global flag`,
          { hint: `Reserved names: ${RESERVED_OPTION_NAMES.join(', ')}.` },
        );
      }
      if (option.short && RESERVED_OPTION_SHORTS.includes(option.short)) {
        throw new PluginError(
          specifier,
          `Command "${command.name}" in plugin "${plugin.name}" declares -${option.short}, which is a reserved global flag`,
        );
      }
    }

    // A variadic positional has to be last, or later args can never be filled.
    const args = command.args ?? [];
    const variadicIndex = args.findIndex((a) => a.variadic);
    if (variadicIndex >= 0 && variadicIndex !== args.length - 1) {
      throw new PluginError(
        specifier,
        `Command "${command.name}" in plugin "${plugin.name}" declares a variadic argument that is not last`,
      );
    }
  }

  for (const provider of plugin.providers ?? []) {
    if (typeof provider?.id !== 'string' || typeof provider.create !== 'function') {
      throw new PluginError(specifier, `Plugin "${plugin.name}" declared an invalid provider`);
    }
  }
}
