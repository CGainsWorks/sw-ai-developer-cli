import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { UsageError } from '../kernel/errors.js';

const run = promisify(execFile);

export interface GitOptions {
  cwd: string;
  /** Injectable for tests. */
  exec?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface DiffOptions {
  /** Diff the index against HEAD instead of the working tree. */
  staged?: boolean;
  /** Diff against this ref, e.g. `origin/main`. */
  base?: string;
  /** Limit to these pathspecs. */
  paths?: string[];
}

export class GitRepo {
  private readonly cwd: string;
  private readonly exec: NonNullable<GitOptions['exec']>;

  constructor(options: GitOptions) {
    this.cwd = options.cwd;
    this.exec =
      options.exec ??
      (async (args, cwd) => {
        // maxBuffer: a large refactor diff blows past Node's 1 MB default and
        // fails with an opaque ENOBUFS.
        const { stdout, stderr } = await run('git', args, {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
        });
        return { stdout, stderr };
      });
  }

  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.exec(['rev-parse', '--is-inside-work-tree'], this.cwd);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async root(): Promise<string> {
    const { stdout } = await this.exec(['rev-parse', '--show-toplevel'], this.cwd);
    return stdout.trim();
  }

  /**
   * Returns a unified diff.
   *
   * `--no-color` and `--no-ext-diff` matter: a user's `diff.external` or
   * `color.ui = always` would otherwise produce something the parser cannot
   * read, and the failure would look like "the model found no changes".
   */
  async diff(options: DiffOptions = {}): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
    if (options.staged) args.push('--cached');
    if (options.base) args.push(`${options.base}...`);
    if (options.paths?.length) args.push('--', ...options.paths);

    const { stdout } = await this.exec(args, this.cwd);
    return stdout;
  }

  async assertRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      throw new UsageError(`Not a git repository: ${this.cwd}`, {
        hint: 'Run this inside a repository, or pass --patch-file to review a saved diff.',
      });
    }
  }
}
