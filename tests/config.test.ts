import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { findConfigFile, loadConfig } from '../src/config/load.js';
import { ConfigError } from '../src/kernel/errors.js';
import { makeTempDir, type TempDir } from './helpers.js';

describe('loadConfig', () => {
  let dir: TempDir;

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => dir.cleanup());

  it('returns defaults when there is no config file', async () => {
    const config = await loadConfig({ cwd: dir.path, env: {}, noConfigFile: true });
    expect(config.provider).toBe('openai');
    expect(config.review.failOn).toBe('error');
    expect(config.configPath).toBeUndefined();
    expect(config.cwd).toBe(dir.path);
  });

  it('reads a config file found by walking up from cwd', async () => {
    dir.file('swai.config.json', JSON.stringify({ provider: 'compat', maxTokens: 1234 }));
    const config = await loadConfig({ cwd: join(dir.path, 'a/b/c'), env: {} });
    expect(config.provider).toBe('compat');
    expect(config.maxTokens).toBe(1234);
    expect(config.configPath).toBe(join(dir.path, 'swai.config.json'));
  });

  it('applies precedence: defaults < file < env < flags', async () => {
    dir.file('swai.config.json', JSON.stringify({ provider: 'openai', model: 'from-file' }));

    const fileOnly = await loadConfig({ cwd: dir.path, env: {} });
    expect(fileOnly.model).toBe('from-file');

    const withEnv = await loadConfig({ cwd: dir.path, env: { SWAI_MODEL: 'from-env' } });
    expect(withEnv.model).toBe('from-env');

    const withFlag = await loadConfig({
      cwd: dir.path,
      env: { SWAI_MODEL: 'from-env' },
      overrides: { model: 'from-flag' },
    });
    expect(withFlag.model).toBe('from-flag');
  });

  it('concatenates plugin lists rather than replacing them', async () => {
    dir.file('swai.config.json', JSON.stringify({ plugins: ['pkg-a'] }));
    const config = await loadConfig({
      cwd: dir.path,
      env: { SWAI_PLUGINS: 'pkg-b' },
      overrides: { plugins: ['pkg-c'] },
    });
    expect(config.plugins).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
  });

  it('resolves relative plugin paths against the config file, not cwd', async () => {
    dir.file('nested/swai.config.json', JSON.stringify({ plugins: ['./my-plugin.js'] }));
    const config = await loadConfig({ cwd: join(dir.path, 'nested'), env: {} });
    expect(config.plugins[0]).toBe(join(dir.path, 'nested', 'my-plugin.js'));
  });

  it('merges nested review and budget objects instead of replacing them', async () => {
    dir.file('swai.config.json', JSON.stringify({ review: { failOn: 'warning' } }));
    const config = await loadConfig({ cwd: dir.path, env: {} });
    expect(config.review.failOn).toBe('warning');
    // maxComments keeps its default rather than becoming undefined.
    expect(config.review.maxComments).toBe(50);
  });

  it('reads budget and json settings from the environment', async () => {
    const config = await loadConfig({
      cwd: dir.path,
      noConfigFile: true,
      env: { SWAI_MAX_USD: '2.5', SWAI_JSON: '1', SWAI_LOG_LEVEL: 'debug', SWAI_MAX_TOKENS: '99' },
    });
    expect(config.budget.maxUsd).toBe(2.5);
    expect(config.json).toBe(true);
    expect(config.logLevel).toBe('debug');
    expect(config.maxTokens).toBe(99);
  });

  it('errors on an explicit --config path that does not exist', async () => {
    await expect(
      loadConfig({ cwd: dir.path, configPath: 'nope.json', env: {} }),
    ).rejects.toThrow(ConfigError);
  });

  it('errors on malformed JSON', async () => {
    dir.file('swai.config.json', '{ not json');
    await expect(loadConfig({ cwd: dir.path, env: {} })).rejects.toThrow(/Invalid JSON/);
  });

  it('errors on a JSON file that is not an object', async () => {
    dir.file('swai.config.json', '[1,2,3]');
    await expect(loadConfig({ cwd: dir.path, env: {} })).rejects.toThrow(/Invalid JSON/);
  });

  it.each([
    [{ maxTokens: 0 }, /maxTokens/],
    [{ timeoutMs: -1 }, /timeoutMs/],
    [{ review: { failOn: 'nope' } }, /failOn/],
    [{ review: { maxComments: -1 } }, /maxComments/],
    [{ budget: { maxUsd: 0 } }, /maxUsd/],
    [{ budget: { maxTokens: 0 } }, /budget.maxTokens|maxTokens/],
    [{ logLevel: 'loud' }, /logLevel/],
  ])('rejects invalid config %#', async (bad, pattern) => {
    dir.file('swai.config.json', JSON.stringify(bad));
    await expect(loadConfig({ cwd: dir.path, env: {} })).rejects.toThrow(pattern);
  });

  it('ignores config files when told to', async () => {
    dir.file('swai.config.json', JSON.stringify({ provider: 'compat' }));
    const config = await loadConfig({ cwd: dir.path, env: {}, noConfigFile: true });
    expect(config.provider).toBe('openai');
  });

  it('merges per-provider settings from the file and from overrides', async () => {
    dir.file(
      'swai.config.json',
      JSON.stringify({
        providerConfig: { compat: { baseUrl: 'http://gpu-box:8000/v1', model: 'from-file' } },
      }),
    );
    const config = await loadConfig({
      cwd: dir.path,
      env: {},
      overrides: { providerConfig: { other: { x: 1 } } },
    });
    expect(config.providerConfig).toEqual({
      compat: { baseUrl: 'http://gpu-box:8000/v1', model: 'from-file' },
      other: { x: 1 },
    });
  });
});

describe('findConfigFile', () => {
  it('returns undefined when nothing is found up to the root', () => {
    const dir = makeTempDir();
    try {
      expect(findConfigFile(dir.path)).toBeUndefined();
    } finally {
      dir.cleanup();
    }
  });

  it('finds .swairc.json as well as swai.config.json', () => {
    const dir = makeTempDir();
    try {
      dir.file('.swairc.json', '{}');
      expect(findConfigFile(dir.path)).toBe(join(dir.path, '.swairc.json'));
    } finally {
      dir.cleanup();
    }
  });
});
