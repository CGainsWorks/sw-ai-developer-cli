import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { UsageError } from './errors.js';

/** Reads all of stdin. Returns '' when stdin is a TTY (nothing piped). */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readTextFile(cwd: string, path: string): Promise<string> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new UsageError(`File not found: ${path}`);
  }
  return readFile(abs, 'utf8');
}

/** Reads several files into a single labelled block for prompt context. */
export async function readContextFiles(
  cwd: string,
  paths: string[],
  maxBytesPerFile = 200_000,
): Promise<string> {
  if (paths.length === 0) return '';
  const blocks: string[] = [];
  for (const path of paths) {
    let contents = await readTextFile(cwd, path);
    if (contents.length > maxBytesPerFile) {
      // Truncating is a last resort, and it is announced rather than silent —
      // a model that does not know it saw a partial file will answer as if it
      // saw all of it.
      contents =
        contents.slice(0, maxBytesPerFile) +
        `\n... [truncated: ${path} is ${contents.length} bytes, showing the first ${maxBytesPerFile}]`;
    }
    blocks.push(`--- ${path} ---\n\`\`\`${languageFor(path)}\n${contents}\n\`\`\``);
  }
  return `Existing files:\n\n${blocks.join('\n\n')}`;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'bash',
  '.bash': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
};

export function languageFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? '';
}
