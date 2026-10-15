export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  readonly level: LogLevel;
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
  /** A logger that prefixes every line, e.g. with a plugin name. */
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Diagnostics go to stderr so stdout stays machine-readable. */
  write?: (line: string) => void;
  prefix?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => void process.stderr.write(line + '\n'));
  const prefix = options.prefix ?? '';

  const emit = (at: LogLevel, tag: string, message: string, rest: unknown[]): void => {
    if (RANK[level] < RANK[at]) return;
    const extra = rest.length > 0 ? ' ' + rest.map(format).join(' ') : '';
    write(`${tag} ${prefix}${message}${extra}`);
  };

  return {
    level,
    error: (m, ...r) => emit('error', 'error:', m, r),
    warn: (m, ...r) => emit('warn', 'warn:', m, r),
    info: (m, ...r) => emit('info', 'info:', m, r),
    debug: (m, ...r) => emit('debug', 'debug:', m, r),
    child: (childPrefix: string) =>
      createLogger({ level, write, prefix: `${prefix}[${childPrefix}] ` }),
  };
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** A logger that swallows everything — the default in tests. */
export const silentLogger: Logger = createLogger({ level: 'silent', write: () => {} });
