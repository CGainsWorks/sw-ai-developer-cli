import { UsageError } from '../kernel/errors.js';
import type { CommandSpec, OptionSpec } from '../plugins/api.js';

/**
 * Argument parsing.
 *
 * Hand-rolled rather than delegated to a parser library because commands are
 * contributed by plugins at runtime: the option table does not exist until
 * plugins have loaded, and the CLI needs global flags resolved *before* that
 * to know which plugins to load. Two-phase parsing against a dynamic spec is
 * simpler to do directly than to bend a declarative parser into.
 */

export interface GlobalOptions {
  configPath?: string;
  noConfigFile: boolean;
  provider?: string;
  model?: string;
  maxTokens?: number;
  json: boolean;
  stream?: boolean;
  color?: boolean;
  logLevel?: string;
  plugins: string[];
  disablePlugins: string[];
  maxUsd?: number;
  tokenBudget?: number;
  cwd?: string;
  help: boolean;
  version: boolean;
}

export interface GlobalParseResult {
  globals: GlobalOptions;
  /** argv with global flags removed: `[command, ...commandArgv]`. */
  rest: string[];
}

interface GlobalFlagSpec {
  name: string;
  takesValue: boolean;
  apply(globals: GlobalOptions, value: string | undefined): void;
}

const GLOBAL_FLAGS: GlobalFlagSpec[] = [
  { name: '--config', takesValue: true, apply: (g, v) => void (g.configPath = v) },
  { name: '--no-config', takesValue: false, apply: (g) => void (g.noConfigFile = true) },
  { name: '--provider', takesValue: true, apply: (g, v) => void (g.provider = v) },
  { name: '--model', takesValue: true, apply: (g, v) => void (g.model = v) },
  {
    name: '--max-tokens',
    takesValue: true,
    apply: (g, v) => void (g.maxTokens = requireNumber('--max-tokens', v)),
  },
  { name: '--json', takesValue: false, apply: (g) => void (g.json = true) },
  { name: '--stream', takesValue: false, apply: (g) => void (g.stream = true) },
  { name: '--no-stream', takesValue: false, apply: (g) => void (g.stream = false) },
  { name: '--color', takesValue: false, apply: (g) => void (g.color = true) },
  { name: '--no-color', takesValue: false, apply: (g) => void (g.color = false) },
  { name: '--log-level', takesValue: true, apply: (g, v) => void (g.logLevel = v) },
  { name: '--verbose', takesValue: false, apply: (g) => void (g.logLevel = 'debug') },
  { name: '--quiet', takesValue: false, apply: (g) => void (g.logLevel = 'error') },
  { name: '--plugin', takesValue: true, apply: (g, v) => void (v && g.plugins.push(v)) },
  {
    name: '--disable-plugin',
    takesValue: true,
    apply: (g, v) => void (v && g.disablePlugins.push(v)),
  },
  {
    name: '--max-usd',
    takesValue: true,
    apply: (g, v) => void (g.maxUsd = requireNumber('--max-usd', v)),
  },
  {
    name: '--token-budget',
    takesValue: true,
    apply: (g, v) => void (g.tokenBudget = requireNumber('--token-budget', v)),
  },
  { name: '--cwd', takesValue: true, apply: (g, v) => void (g.cwd = v) },
  { name: '--help', takesValue: false, apply: (g) => void (g.help = true) },
  { name: '-h', takesValue: false, apply: (g) => void (g.help = true) },
  { name: '--version', takesValue: false, apply: (g) => void (g.version = true) },
  { name: '-V', takesValue: false, apply: (g) => void (g.version = true) },
];

const GLOBAL_BY_NAME = new Map(GLOBAL_FLAGS.map((f) => [f.name, f]));

/**
 * Extracts global flags from anywhere in argv.
 *
 * Everything after a literal `--`, and everything after the command's own
 * arguments start, is left alone — except that global flags are still
 * recognised after the command name, because `swai review --json` is what
 * people type.
 */
export function parseGlobals(argv: string[]): GlobalParseResult {
  const globals: GlobalOptions = {
    noConfigFile: false,
    json: false,
    plugins: [],
    disablePlugins: [],
    help: false,
    version: false,
  };
  const rest: string[] = [];

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (passthrough) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      rest.push(token);
      continue;
    }

    const [name, inlineValue] = splitInline(token);
    const flag = GLOBAL_BY_NAME.get(name);
    if (!flag) {
      rest.push(token);
      continue;
    }

    if (!flag.takesValue) {
      if (inlineValue !== undefined) {
        throw new UsageError(`${name} does not take a value`);
      }
      flag.apply(globals, undefined);
      continue;
    }

    if (inlineValue !== undefined) {
      flag.apply(globals, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new UsageError(`${name} requires a value`);
    }
    flag.apply(globals, next);
    i++;
  }

  return { globals, rest };
}

/**
 * Parses a command's own arguments against its declared spec.
 *
 * Long option `--fail-on` lands in `options.failOn`. That camelCase mapping is
 * part of the plugin contract, so a plugin author reads its own flag with the
 * name they would write in TypeScript.
 */
export function parseCommand(
  spec: CommandSpec,
  argv: string[],
): { args: Record<string, string | string[] | undefined>; options: Record<string, unknown> } {
  const optionSpecs = spec.options ?? [];
  const byLong = new Map(optionSpecs.map((o) => [o.name, o]));
  const byShort = new Map(
    optionSpecs.filter((o) => o.short).map((o) => [o.short as string, o]),
  );

  const options: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (const option of optionSpecs) {
    if (option.default !== undefined) options[camelCase(option.name)] = option.default;
  }

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (passthrough || !token.startsWith('-') || token === '-') {
      if (token === '--' && !passthrough) {
        passthrough = true;
        continue;
      }
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    const [rawName, inlineValue] = splitInline(token);
    const isLong = rawName.startsWith('--');
    const bare = isLong ? rawName.slice(2) : rawName.slice(1);

    // `--no-foo` turns a boolean off.
    if (isLong && bare.startsWith('no-')) {
      const target = byLong.get(bare.slice(3));
      if (target && target.type === 'boolean') {
        options[camelCase(target.name)] = false;
        continue;
      }
    }

    const option = isLong ? byLong.get(bare) : byShort.get(bare);
    if (!option) {
      throw new UsageError(`Unknown option "${rawName}" for command "${spec.name}"`, {
        hint: `Run \`swai ${spec.name} --help\` to see the available options.`,
      });
    }

    const key = camelCase(option.name);

    if (option.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new UsageError(`${rawName} is a flag and does not take a value`);
      }
      options[key] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      // A negative number is a value, not a flag.
      if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) {
        throw new UsageError(`${rawName} requires a value`);
      }
      value = next;
      i++;
    }

    assignValue(options, key, option, value, rawName);
  }

  const args = bindPositionals(spec, positionals);
  validateRequiredOptions(spec, options);

  return { args, options };
}

function assignValue(
  options: Record<string, unknown>,
  key: string,
  option: OptionSpec,
  value: string,
  rawName: string,
): void {
  if (option.choices && !option.choices.includes(value)) {
    throw new UsageError(
      `Invalid value "${value}" for ${rawName}. Expected one of: ${option.choices.join(', ')}`,
    );
  }

  if (option.type === 'number') {
    options[key] = requireNumber(rawName, value);
    return;
  }
  if (option.type === 'string[]') {
    const existing = Array.isArray(options[key]) ? (options[key] as string[]) : [];
    options[key] = [...existing, value];
    return;
  }
  options[key] = value;
}

function bindPositionals(
  spec: CommandSpec,
  positionals: string[],
): Record<string, string | string[] | undefined> {
  const args: Record<string, string | string[] | undefined> = {};
  const argSpecs = spec.args ?? [];

  let cursor = 0;
  for (const argSpec of argSpecs) {
    if (argSpec.variadic) {
      const rest = positionals.slice(cursor);
      cursor = positionals.length;
      if (argSpec.required && rest.length === 0) {
        throw new UsageError(`Missing required argument <${argSpec.name}> for "${spec.name}"`);
      }
      args[argSpec.name] = rest;
      continue;
    }

    const value = positionals[cursor];
    if (value === undefined) {
      if (argSpec.required) {
        throw new UsageError(`Missing required argument <${argSpec.name}> for "${spec.name}"`);
      }
      args[argSpec.name] = undefined;
      continue;
    }
    args[argSpec.name] = value;
    cursor++;
  }

  if (cursor < positionals.length) {
    const extra = positionals.slice(cursor);
    throw new UsageError(
      `Unexpected argument${extra.length > 1 ? 's' : ''} for "${spec.name}": ${extra.join(' ')}`,
    );
  }

  return args;
}

function validateRequiredOptions(spec: CommandSpec, options: Record<string, unknown>): void {
  for (const option of spec.options ?? []) {
    if (!option.required) continue;
    const value = options[camelCase(option.name)];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      throw new UsageError(`Missing required option --${option.name} for "${spec.name}"`);
    }
  }
}

function splitInline(token: string): [string, string | undefined] {
  const eq = token.indexOf('=');
  if (eq <= 0 || !token.startsWith('-')) return [token, undefined];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

function requireNumber(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(n)) {
    throw new UsageError(`${flag} expects a number, got "${String(value)}"`);
  }
  return n;
}

export function camelCase(name: string): string {
  return name.replace(/-([a-zA-Z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}
