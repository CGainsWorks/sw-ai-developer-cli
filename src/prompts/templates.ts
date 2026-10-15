import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from '../kernel/errors.js';

/**
 * Prompt templates live as `.md` files so they can be read, diffed and
 * overridden without touching TypeScript. See docs/prompt_design.md for why
 * each one is shaped the way it is.
 *
 * Resolution order: `templatesDir` from config, then the packaged templates.
 * That lets a project override one template without vendoring them all.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Packaged template directory.
 *
 * `import.meta.url` is `<pkg>/src/prompts/templates.ts` in tests and
 * `<pkg>/dist/prompts/templates.js` when installed. `../../templates/`
 * resolves to `<pkg>/templates/` in both cases.
 */
export const PACKAGED_TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

export interface TemplateLoaderOptions {
  /** Checked before the packaged directory. */
  templatesDir?: string;
  cwd?: string;
}

export class TemplateLoader {
  private readonly searchDirs: string[];
  private readonly cache = new Map<string, string>();

  constructor(options: TemplateLoaderOptions = {}) {
    const dirs: string[] = [];
    if (options.templatesDir) {
      dirs.push(resolve(options.cwd ?? process.cwd(), options.templatesDir));
    }
    dirs.push(PACKAGED_TEMPLATES_DIR);
    this.searchDirs = dirs;
  }

  async read(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    for (const dir of this.searchDirs) {
      const path = join(dir, fileName);
      if (existsSync(path)) {
        const contents = await readFile(path, 'utf8');
        this.cache.set(name, contents);
        return contents;
      }
    }

    throw new ConfigError(
      `Prompt template "${fileName}" not found in: ${this.searchDirs.join(', ')}`,
      { hint: 'Check the template name, or point `templatesDir` at your overrides.' },
    );
  }

  async render(name: string, vars: Record<string, string>): Promise<string> {
    return renderTemplate(await this.read(name), vars, name);
  }
}

/**
 * Substitutes `{{name}}` placeholders.
 *
 * An unfilled placeholder throws rather than rendering as an empty string: a
 * prompt that silently loses its input produces a confidently wrong answer,
 * which is the worst failure mode available here.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  templateName = '<inline>',
): string {
  const missing: string[] = [];
  const output = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      missing.push(key);
      return '';
    }
    return value;
  });

  if (missing.length > 0) {
    throw new ConfigError(
      `Template "${templateName}" has unfilled placeholders: ${[...new Set(missing)].join(', ')}`,
    );
  }
  return output;
}
