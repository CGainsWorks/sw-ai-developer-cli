/**
 * The streaming output renderer.
 *
 * stdout carries the payload (generated code, review text, JSON). Diagnostics
 * go to stderr via the logger. In `--json` mode every human-facing write is
 * suppressed so stdout stays a single parseable document.
 */

export interface RendererOptions {
  json?: boolean;
  /** Defaults to process.stdout.write. */
  write?: (chunk: string) => void;
  /** Disables ANSI styling; auto-detected from TTY when omitted. */
  color?: boolean;
}

export interface OutputRenderer {
  readonly isJson: boolean;
  /** Write without a trailing newline — the streaming path. */
  text(chunk: string): void;
  /** Write a line. No-op in JSON mode. */
  line(text?: string): void;
  /** Emit the machine-readable result. Only produces output in JSON mode. */
  json(data: unknown): void;
  /** Everything written so far, for tests. */
  captured(): string;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
}

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
};

export function createRenderer(options: RendererOptions = {}): OutputRenderer {
  const isJson = options.json ?? false;
  const buffer: string[] = [];
  const sink = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const color =
    options.color ??
    (!isJson && process.stdout.isTTY === true && process.env.NO_COLOR === undefined);

  const emit = (chunk: string): void => {
    buffer.push(chunk);
    sink(chunk);
  };

  const paint =
    (code: string) =>
    (text: string): string =>
      color ? `${code}${text}${ANSI.reset}` : text;

  return {
    isJson,
    text(chunk) {
      if (isJson) return;
      emit(chunk);
    },
    line(text = '') {
      if (isJson) return;
      emit(text + '\n');
    },
    json(data) {
      if (!isJson) return;
      emit(JSON.stringify(data, null, 2) + '\n');
    },
    captured() {
      return buffer.join('');
    },
    bold: paint(ANSI.bold),
    dim: paint(ANSI.dim),
    red: paint(ANSI.red),
    yellow: paint(ANSI.yellow),
    green: paint(ANSI.green),
    cyan: paint(ANSI.cyan),
  };
}
