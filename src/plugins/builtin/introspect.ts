/**
 * Introspection commands.
 *
 * These exist as a plugin rather than as CLI built-ins for the same reason the
 * three main commands do: if `swai plugins` needed privileged kernel access,
 * the plugin API would be missing something real.
 */

import { ExitCode } from '../../kernel/exit-codes.js';
import { DEFAULT_PRICING, formatUsd, type PriceTable } from '../../providers/pricing.js';
import {
  definePlugin,
  getBoolean,
  PLUGIN_API_VERSION,
  type CommandContext,
  type CommandResult,
} from '../api.js';

export function runPlugins(ctx: CommandContext): CommandResult {
  // Not `--verbose`: that is a reserved global flag (see RESERVED_OPTION_NAMES).
  const showHooks = getBoolean(ctx.options, 'hooks');
  const plugins = [...ctx.plugins];

  if (!ctx.out.isJson) {
    for (const plugin of plugins) {
      const tag = plugin.builtin ? ctx.out.dim(' (built-in)') : '';
      const version = plugin.version ? ctx.out.dim(` v${plugin.version}`) : '';
      ctx.out.line(`${ctx.out.bold(plugin.name)}${version}${tag}`);
      if (plugin.description) ctx.out.line(`  ${plugin.description}`);
      if (plugin.commands.length) {
        ctx.out.line(`  ${ctx.out.dim('commands:')}  ${plugin.commands.join(', ')}`);
      }
      if (plugin.providers.length) {
        ctx.out.line(`  ${ctx.out.dim('providers:')} ${plugin.providers.join(', ')}`);
      }
      if (showHooks && plugin.hooks.length) {
        ctx.out.line(`  ${ctx.out.dim('hooks:')}     ${plugin.hooks.join(', ')}`);
      }
      ctx.out.line();
    }
    ctx.out.line(
      ctx.out.dim(
        `${plugins.length} plugin(s) loaded. Disable one with --disable-plugin <name>.`,
      ),
    );
  }

  return {
    exitCode: ExitCode.Ok,
    data: { plugins },
    summary: `${plugins.length} plugin(s) loaded`,
  };
}

export function runPrice(ctx: CommandContext): CommandResult {
  const table: PriceTable = { ...DEFAULT_PRICING, ...ctx.config.pricing };
  const overridden = new Set(Object.keys(ctx.config.pricing));
  const rows = Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, price]) => ({
      model,
      inputPerMTok: price.input,
      outputPerMTok: price.output,
      overridden: overridden.has(model),
    }));

  if (!ctx.out.isJson) {
    ctx.out.line(ctx.out.bold('Effective prices (USD per 1M tokens)'));
    ctx.out.line();
    const width = Math.max(...rows.map((r) => r.model.length), 5);
    ctx.out.line(ctx.out.dim(`${'model'.padEnd(width)}   input    output`));
    for (const row of rows) {
      const marker = row.overridden ? ctx.out.cyan(' *') : '';
      ctx.out.line(
        `${row.model.padEnd(width)}  ${formatUsd(row.inputPerMTok).padStart(7)}  ` +
          `${formatUsd(row.outputPerMTok).padStart(8)}${marker}`,
      );
    }
    ctx.out.line();
    ctx.out.line(
      ctx.out.dim(
        overridden.size > 0
          ? '* overridden by "pricing" in your config.'
          : 'Override any row with "pricing" in your config. Unlisted models report cost as unknown.',
      ),
    );
    ctx.out.line(
      ctx.out.dim(
        'The compat provider prices its models at providerConfig.compat.price (default $0) ' +
          'unless "pricing" lists them.',
      ),
    );
  }

  return {
    exitCode: ExitCode.Ok,
    data: { prices: rows },
    summary: `${rows.length} model price(s)`,
  };
}

export default definePlugin({
  name: 'introspect',
  apiVersion: PLUGIN_API_VERSION,
  description: 'Adds `plugins` and `price`, which report what is loaded and what it costs.',
  commands: [
    {
      name: 'plugins',
      description: 'List loaded plugins and what they contribute',
      options: [
        { name: 'hooks', description: 'Also list the hooks each plugin implements', type: 'boolean' },
      ],
      examples: ['swai plugins', 'swai plugins --hooks', 'swai plugins --json'],
      run: runPlugins,
    },
    {
      name: 'price',
      description: 'Show the effective token price table',
      examples: ['swai price', 'swai price --json'],
      run: runPrice,
    },
  ],
});
