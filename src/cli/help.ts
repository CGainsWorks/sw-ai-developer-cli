import { ExitCode, exitCodeName } from '../kernel/exit-codes.js';
import type { CommandSpec } from '../plugins/api.js';

const GLOBAL_HELP = `Global options:
  --provider <id>          Model provider (openai, compat)
  --model <name>           Model id, overriding the provider default
  --max-tokens <n>         Output token ceiling per request
  --json                   Emit a single JSON document on stdout
  --no-stream              Wait for the whole response instead of streaming
  --plugin <spec>          Load a plugin by path or package name (repeatable)
  --disable-plugin <name>  Turn off a loaded plugin (repeatable)
  --config <path>          Use this config file
  --no-config              Ignore config files entirely
  --max-usd <n>            Abort once spend passes this many dollars
  --token-budget <n>       Abort once total tokens pass this
  --cwd <dir>              Run as if from this directory
  --log-level <level>      silent | error | warn | info | debug
  --verbose, --quiet       Shortcuts for --log-level debug / error
  --no-color               Disable ANSI colour
  -h, --help               Show help
  -V, --version            Show version`;

export function formatRootHelp(commands: CommandSpec[], version: string): string {
  const width = Math.max(...commands.map((c) => c.name.length), 8);
  const lines = [
    `swai ${version}: generate, review and explain code with OpenAI or any OpenAI-compatible model.`,
    '',
    'Usage:',
    '  swai <command> [options]',
    '',
    'Commands:',
    ...[...commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `  ${c.name.padEnd(width)}  ${c.description}`),
    '',
    GLOBAL_HELP,
    '',
    'Exit codes:',
    ...Object.values(ExitCode)
      .filter((code): code is ExitCode => typeof code === 'number')
      .sort((a, b) => a - b)
      .map((code) => `  ${String(code).padEnd(2)}  ${describeExit(code)}`),
    '',
    'Run `swai <command> --help` for command-specific options.',
  ];
  return lines.join('\n');
}

export function formatCommandHelp(command: CommandSpec): string {
  const lines: string[] = [];

  const argUsage = (command.args ?? [])
    .map((a) => {
      const name = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${name}>` : `[${name}]`;
    })
    .join(' ');

  lines.push(`swai ${command.name}${argUsage ? ' ' + argUsage : ''} [options]`);
  lines.push('');
  lines.push(command.description);

  if (command.args?.length) {
    lines.push('', 'Arguments:');
    const width = Math.max(...command.args.map((a) => a.name.length));
    for (const arg of command.args) {
      lines.push(`  ${arg.name.padEnd(width)}  ${arg.description}`);
    }
  }

  if (command.options?.length) {
    lines.push('', 'Options:');
    const rendered = command.options.map((option) => {
      const short = option.short ? `-${option.short}, ` : '    ';
      const value =
        option.type === 'boolean'
          ? ''
          : option.type === 'string[]'
            ? ' <value...>'
            : ` <${option.type === 'number' ? 'n' : 'value'}>`;
      return { flag: `${short}--${option.name}${value}`, option };
    });
    const width = Math.max(...rendered.map((r) => r.flag.length));
    for (const { flag, option } of rendered) {
      const extras: string[] = [];
      if (option.choices) extras.push(`one of: ${option.choices.join(', ')}`);
      if (option.default !== undefined) extras.push(`default: ${String(option.default)}`);
      const suffix = extras.length ? ` (${extras.join('; ')})` : '';
      lines.push(`  ${flag.padEnd(width)}  ${option.description}${suffix}`);
    }
  }

  if (command.examples?.length) {
    lines.push('', 'Examples:');
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  lines.push('', 'Run `swai --help` for global options.');
  return lines.join('\n');
}

function describeExit(code: ExitCode): string {
  const descriptions: Record<number, string> = {
    [ExitCode.Ok]: 'success',
    [ExitCode.Error]: 'unclassified error',
    [ExitCode.Usage]: 'bad invocation',
    [ExitCode.Config]: 'configuration problem',
    [ExitCode.Provider]: 'provider failure (auth, rate limit, network)',
    [ExitCode.Findings]: 'review findings at or above --fail-on',
    [ExitCode.PatchFailed]: 'patch did not apply cleanly',
    [ExitCode.BudgetExceeded]: 'token or cost budget exceeded',
    [ExitCode.PluginError]: 'plugin failed to load',
  };
  return descriptions[code] ?? exitCodeName(code);
}
