import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { loadPlugin, assertValidPlugin } from '../src/plugins/loader.js';
import { Registry } from '../src/plugins/registry.js';
import { HookBus } from '../src/kernel/hooks.js';
import { PluginError } from '../src/kernel/errors.js';
import { PLUGIN_API_VERSION, type Plugin, type ReviewComment } from '../src/plugins/api.js';
import { createLogger, silentLogger } from '../src/kernel/logger.js';
import { makeSink, makeTempDir } from './helpers.js';

const validPlugin: Plugin = {
  name: 'demo',
  apiVersion: PLUGIN_API_VERSION,
  commands: [{ name: 'demo', description: 'demo', run: () => ({ exitCode: 0 }) }],
};

describe('loadPlugin', () => {
  const cwd = process.cwd();

  it('accepts a default export', async () => {
    const plugin = await loadPlugin('virtual', {
      cwd,
      importModule: async () => ({ default: validPlugin }),
    });
    expect(plugin.name).toBe('demo');
  });

  it('accepts a named `plugin` export', async () => {
    const plugin = await loadPlugin('virtual', {
      cwd,
      importModule: async () => ({ plugin: validPlugin }),
    });
    expect(plugin.name).toBe('demo');
  });

  it('accepts a factory function', async () => {
    const plugin = await loadPlugin('virtual', {
      cwd,
      importModule: async () => ({ default: () => validPlugin }),
    });
    expect(plugin.name).toBe('demo');
  });

  it('loads a real module from disk, proving out-of-tree plugins work', async () => {
    const dir = makeTempDir();
    try {
      dir.file(
        'my-plugin.mjs',
        `export default {
           name: 'from-disk',
           apiVersion: ${PLUGIN_API_VERSION},
           commands: [{ name: 'hello', description: 'says hello', run: () => ({ exitCode: 0 }) }],
         };`,
      );
      const plugin = await loadPlugin('./my-plugin.mjs', { cwd: dir.path });
      expect(plugin.name).toBe('from-disk');
      expect(plugin.commands?.[0]?.name).toBe('hello');
    } finally {
      dir.cleanup();
    }
  });

  it('reports a helpful error when the module cannot be imported', async () => {
    await expect(loadPlugin('./nope.mjs', { cwd: process.cwd() })).rejects.toThrow(PluginError);
  });

  it('surfaces why the import failed, not just that it did', async () => {
    const dir = makeTempDir();
    try {
      dir.file('broken.mjs', 'export default { this is not valid javascript');
      // A syntax error in a plugin and a missing file are different problems;
      // the message has to say which one happened.
      await expect(loadPlugin('./broken.mjs', { cwd: dir.path })).rejects.toThrow(
        /Could not load plugin ".\/broken\.mjs": .+/,
      );
    } finally {
      dir.cleanup();
    }
  });

  it('canonicalises the path before importing, so one plugin is one module', async () => {
    const dir = makeTempDir();
    try {
      const real = join(dir.path, 'real');
      mkdirSync(real, { recursive: true });
      writeFileSync(
        join(real, 'p.mjs'),
        `export default { name: 'canon', apiVersion: ${PLUGIN_API_VERSION} };`,
      );

      const link = join(dir.path, 'link');
      try {
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return; // No permission to create links here; nothing to assert.
      }

      // Reached through a symlink, the plugin must still resolve to the real
      // file — otherwise the same plugin loads twice, with separate state.
      const viaLink = await loadPlugin(join(link, 'p.mjs'), { cwd: dir.path });
      expect(viaLink.name).toBe('canon');
    } finally {
      dir.cleanup();
    }
  });

  it('loads a plugin from a directory unrelated to the project root', async () => {
    // Regression guard: the loader must use Node's own import rather than the
    // host bundler's module graph, which cannot resolve paths outside the
    // project (on Windows CI, a different drive entirely).
    const dir = makeTempDir();
    try {
      dir.file(
        'far-away.mjs',
        `export default { name: 'far-away', apiVersion: ${PLUGIN_API_VERSION} };`,
      );
      const plugin = await loadPlugin(dir.path + '/far-away.mjs', { cwd: process.cwd() });
      expect(plugin.name).toBe('far-away');
    } finally {
      dir.cleanup();
    }
  });

  it('rejects a module with no plugin export', async () => {
    await expect(
      loadPlugin('virtual', { cwd, importModule: async () => ({ somethingElse: 1 }) }),
    ).rejects.toThrow(/no default export/);
  });

  it('rejects a non-object module', async () => {
    await expect(
      loadPlugin('virtual', { cwd, importModule: async () => 'not a module' }),
    ).rejects.toThrow(/did not export a module object/);
  });
});

describe('assertValidPlugin', () => {
  it('requires a name and an apiVersion', () => {
    expect(() => assertValidPlugin({}, 'x')).toThrow(/missing a "name"/);
    expect(() => assertValidPlugin({ name: 'a' }, 'x')).toThrow(/missing "apiVersion"/);
  });

  it('refuses a plugin built for a different API version', () => {
    expect(() => assertValidPlugin({ name: 'a', apiVersion: 99 }, 'x')).toThrow(
      /targets plugin API v99/,
    );
  });

  it('rejects malformed commands', () => {
    expect(() =>
      assertValidPlugin({ name: 'a', apiVersion: PLUGIN_API_VERSION, commands: [{}] }, 'x'),
    ).toThrow(/command with no name/);

    expect(() =>
      assertValidPlugin(
        { name: 'a', apiVersion: PLUGIN_API_VERSION, commands: [{ name: 'c' }] },
        'x',
      ),
    ).toThrow(/no run\(\) function/);
  });

  it('rejects a variadic argument that is not last', () => {
    expect(() =>
      assertValidPlugin(
        {
          name: 'a',
          apiVersion: PLUGIN_API_VERSION,
          commands: [
            {
              name: 'c',
              run: () => ({ exitCode: 0 }),
              args: [
                { name: 'many', description: '', variadic: true },
                { name: 'after', description: '' },
              ],
            },
          ],
        },
        'x',
      ),
    ).toThrow(/variadic argument that is not last/);
  });

  it('rejects an invalid provider', () => {
    expect(() =>
      assertValidPlugin(
        { name: 'a', apiVersion: PLUGIN_API_VERSION, providers: [{ id: 'x' }] },
        'x',
      ),
    ).toThrow(/invalid provider/);
  });
});

describe('Registry', () => {
  it('rejects duplicate plugin names', () => {
    const registry = new Registry();
    registry.addPlugin(validPlugin);
    expect(() => registry.addPlugin(validPlugin)).toThrow(/already loaded/);
  });

  it('rejects two plugins claiming the same command', () => {
    const registry = new Registry();
    registry.registerCommand('a', { name: 'review', description: '', run: () => ({ exitCode: 0 }) });
    expect(() =>
      registry.registerCommand('b', {
        name: 'review',
        description: '',
        run: () => ({ exitCode: 0 }),
      }),
    ).toThrow(/already registered by plugin "a"/);
  });

  it('rejects two plugins claiming the same provider id', () => {
    const registry = new Registry();
    const factory = { id: 'p', defaultModel: 'm', apiKeyEnvVar: 'K', create: () => ({}) as never };
    registry.registerProvider('a', factory);
    expect(() => registry.registerProvider('b', factory)).toThrow(/already registered/);
  });

  it('groups contributions by owning plugin', () => {
    const registry = new Registry();
    registry.registerCommand('a', { name: 'x', description: '', run: () => ({ exitCode: 0 }) });
    registry.registerCommand('a', { name: 'y', description: '', run: () => ({ exitCode: 0 }) });
    registry.registerCommand('b', { name: 'z', description: '', run: () => ({ exitCode: 0 }) });

    expect(registry.commandsByPlugin().get('a')).toEqual(['x', 'y']);
    expect(registry.commandOwner('z')).toBe('b');
    expect(registry.listCommands()).toHaveLength(3);
  });
});

describe('HookBus', () => {
  it('chains transform hooks, feeding each the previous result', async () => {
    const bus = new HookBus(silentLogger);
    bus.add('one', {
      reviewComments: ({ comments }) => [...comments, makeComment('a')],
    });
    bus.add('two', {
      reviewComments: ({ comments }) => [...comments, makeComment('b')],
    });

    const out = await bus.reviewComments({ comments: [], diff: [], config: {} as never });
    expect(out.map((c) => c.message)).toEqual(['a', 'b']);
  });

  it('leaves the value untouched when a transform hook returns nothing', async () => {
    const bus = new HookBus(silentLogger);
    const seen: number[] = [];
    bus.add('observer', {
      reviewComments: ({ comments }) => void seen.push(comments.length),
    });

    const initial = [makeComment('keep')];
    const out = await bus.reviewComments({ comments: initial, diff: [], config: {} as never });
    expect(out).toEqual(initial);
    expect(seen).toEqual([1]);
  });

  it('attributes comments a hook added but did not label', async () => {
    const bus = new HookBus(silentLogger);
    bus.add('policy', { reviewComments: () => [makeComment('added')] });
    const [comment] = await bus.reviewComments({ comments: [], diff: [], config: {} as never });
    expect(comment?.source).toBe('policy');
  });

  it('does not re-attribute comments a hook merely passed through', async () => {
    const bus = new HookBus(silentLogger);
    const fromModel = makeComment('from the model');
    bus.add('policy', {
      // A filtering hook returns the same objects it was handed. Crediting it
      // with those findings would misreport where they came from.
      reviewComments: ({ comments }) => [...comments, makeComment('mine')],
    });

    const out = await bus.reviewComments({
      comments: [fromModel],
      diff: [],
      config: {} as never,
    });

    expect(out[0]?.source).toBeUndefined();
    expect(out[1]?.source).toBe('policy');
  });

  it('lets beforeModelCall rewrite the request', async () => {
    const bus = new HookBus(silentLogger);
    bus.add('rewriter', {
      beforeModelCall: ({ request }) => ({ ...request, system: 'rewritten' }),
    });
    const out = await bus.beforeModelCall({
      command: 'x',
      request: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(out.system).toBe('rewritten');
  });

  it('isolates a throwing observer hook so one plugin cannot break a command', async () => {
    const sink = makeSink();
    const bus = new HookBus(createLogger({ level: 'warn', write: sink.write }));
    const after = vi.fn();

    bus.add('bad', {
      beforeCommand: () => {
        throw new Error('boom');
      },
    });
    bus.add('good', { beforeCommand: after });

    await expect(bus.beforeCommand({ command: 'x', options: {} })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledOnce();
    expect(sink.text()).toContain('plugin "bad" threw in beforeCommand');
  });

  it('does NOT swallow a throwing transform hook', async () => {
    const bus = new HookBus(silentLogger);
    bus.add('filter', {
      reviewComments: () => {
        throw new Error('filter failed');
      },
    });
    // Silently keeping unfiltered comments would be worse than failing.
    await expect(
      bus.reviewComments({ comments: [makeComment('x')], diff: [], config: {} as never }),
    ).rejects.toThrow('filter failed');
  });

  it('reports which hooks each plugin implements', () => {
    const bus = new HookBus(silentLogger);
    bus.add('p', { beforeCommand: () => {}, reviewComments: () => {} });
    expect(bus.hookNamesByPlugin().get('p')).toEqual(['beforeCommand', 'reviewComments']);
    expect(bus.size).toBe(1);
  });

  it('lets beforePatch rewrite the change set', async () => {
    const bus = new HookBus(silentLogger);
    bus.add('vetoer', { beforePatch: () => [] });
    const out = await bus.beforePatch({
      changes: [{ path: 'a.ts', kind: 'modify', contents: 'x' }],
      dryRun: true,
    });
    expect(out).toEqual([]);
  });
});

function makeComment(message: string): ReviewComment {
  return { file: 'a.ts', line: 1, severity: 'warning', category: 'test', message };
}
