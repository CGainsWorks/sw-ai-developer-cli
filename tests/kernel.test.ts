import { describe, expect, it, vi } from 'vitest';

import { Kernel } from '../src/kernel/kernel.js';
import { createRenderer } from '../src/output/renderer.js';
import { createLogger, silentLogger } from '../src/kernel/logger.js';
import { ExitCode } from '../src/kernel/exit-codes.js';
import { PluginError, ProviderError, BudgetExceededError } from '../src/kernel/errors.js';
import { PLUGIN_API_VERSION, type CommandContext, type Plugin } from '../src/plugins/api.js';
import { makeConfig, makeFakeProvider, makeSink } from './helpers.js';

function capturePlugin(onRun: (ctx: CommandContext) => Promise<void> | void): Plugin {
  return {
    name: 'capture',
    apiVersion: PLUGIN_API_VERSION,
    commands: [
      {
        name: 'capture',
        description: 'test command',
        run: async (ctx) => {
          await onRun(ctx);
          return { exitCode: ExitCode.Ok, data: { ok: true }, summary: 'done' };
        },
      },
    ],
  };
}

describe('Kernel', () => {
  it('registers commands from plugins and dispatches to them', async () => {
    const run = vi.fn();
    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [capturePlugin(run)],
      provider: makeFakeProvider(),
    });

    expect(kernel.registry.listCommands().map((c) => c.name)).toEqual(['capture']);
    const result = await kernel.run('capture', { args: {}, options: {} });
    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(run).toHaveBeenCalledOnce();
  });

  it('routes ctx.complete through hooks and records usage', async () => {
    const provider = makeFakeProvider({ responses: ['the answer'] });
    const seen: string[] = [];

    const hookPlugin: Plugin = {
      name: 'hooker',
      apiVersion: PLUGIN_API_VERSION,
      hooks: {
        beforeModelCall: ({ request }) => {
          seen.push('before');
          return { ...request, system: 'injected by hook' };
        },
        afterModelCall: ({ result }) => void seen.push(`after:${result.text}`),
      },
    };

    let text = '';
    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [
        hookPlugin,
        capturePlugin(async (ctx) => {
          const result = await ctx.complete({ messages: [{ role: 'user', content: 'q' }] });
          text = result.text;
        }),
      ],
      provider,
    });

    await kernel.run('capture', { args: {}, options: {} });

    expect(text).toBe('the answer');
    expect(seen).toEqual(['before', 'after:the answer']);
    // The hook's rewrite actually reached the provider.
    expect(provider.calls[0]?.system).toBe('injected by hook');
    expect(kernel.usage.summary().calls).toBe(1);
    expect(kernel.usage.summary().inputTokens).toBe(100);
  });

  it('writes streamed text to the renderer as it arrives', async () => {
    const sink = makeSink();
    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      renderer: createRenderer({ write: sink.write, color: false }),
      builtins: [
        capturePlugin(async (ctx) => {
          await ctx.streamText({ messages: [{ role: 'user', content: 'q' }] });
        }),
      ],
      provider: makeFakeProvider({ responses: ['streamed output'], chunks: 3 }),
    });

    await kernel.run('capture', { args: {}, options: {} });
    expect(sink.text()).toBe('streamed output');
  });

  it('enforces the budget through the usage tracker', async () => {
    const kernel = await Kernel.create({
      config: makeConfig({ budget: { maxTokens: 10 } }),
      logger: silentLogger,
      builtins: [
        capturePlugin(async (ctx) => {
          await ctx.complete({ messages: [{ role: 'user', content: 'q' }] });
        }),
      ],
      provider: makeFakeProvider(),
    });

    await expect(kernel.run('capture', { args: {}, options: {} })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('runs setup() and lets a plugin register commands conditionally', async () => {
    const dynamic: Plugin = {
      name: 'dynamic',
      apiVersion: PLUGIN_API_VERSION,
      setup(ctx) {
        if (ctx.settings.enabled === true) {
          ctx.registerCommand({
            name: 'extra',
            description: 'conditionally registered',
            run: () => ({ exitCode: ExitCode.Ok }),
          });
        }
      },
    };

    const off = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [dynamic],
      provider: makeFakeProvider(),
    });
    expect(off.registry.getCommand('extra')).toBeUndefined();

    const on = await Kernel.create({
      config: makeConfig({ pluginConfig: { dynamic: { enabled: true } } }),
      logger: silentLogger,
      builtins: [dynamic],
      provider: makeFakeProvider(),
    });
    expect(on.registry.getCommand('extra')).toBeDefined();
    // Commands added during setup are still attributed to their plugin.
    expect(on.listPluginInfo()[0]?.commands).toEqual(['extra']);
  });

  it('wraps a failure inside setup() as a PluginError', async () => {
    const bad: Plugin = {
      name: 'bad',
      apiVersion: PLUGIN_API_VERSION,
      setup() {
        throw new Error('setup blew up');
      },
    };
    await expect(
      Kernel.create({ config: makeConfig(), logger: silentLogger, builtins: [bad] }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('honours disablePlugins for built-ins', async () => {
    const kernel = await Kernel.create({
      config: makeConfig({ disablePlugins: ['capture'] }),
      logger: silentLogger,
      builtins: [capturePlugin(() => {})],
      provider: makeFakeProvider(),
    });
    expect(kernel.registry.listCommands()).toEqual([]);
  });

  it('loads external plugins listed in config', async () => {
    const external: Plugin = {
      name: 'external',
      apiVersion: PLUGIN_API_VERSION,
      commands: [{ name: 'ext', description: 'from outside', run: () => ({ exitCode: 0 }) }],
    };

    const kernel = await Kernel.create({
      config: makeConfig({ plugins: ['some-package'] }),
      logger: silentLogger,
      builtins: [],
      importModule: async () => ({ default: external }),
      provider: makeFakeProvider(),
    });

    expect(kernel.registry.getCommand('ext')).toBeDefined();
    expect(kernel.listPluginInfo()[0]).toMatchObject({ name: 'external', builtin: false });
  });

  it('resolves a provider from the registry, lazily', async () => {
    const factoryCalls: number[] = [];
    const providerPlugin: Plugin = {
      name: 'p',
      apiVersion: PLUGIN_API_VERSION,
      providers: [
        {
          id: 'fake',
          defaultModel: 'fake-1',
          apiKeyEnvVar: 'NONE',
          create: (options) => {
            factoryCalls.push(1);
            return makeFakeProvider({ model: options.model ?? 'fake-1' });
          },
        },
      ],
    };

    const kernel = await Kernel.create({
      config: makeConfig({ provider: 'fake', model: 'chosen-model' }),
      logger: silentLogger,
      builtins: [providerPlugin, capturePlugin(() => {})],
    });

    // Nothing constructed until something asks for it.
    expect(factoryCalls).toHaveLength(0);
    expect(kernel.provider().model).toBe('chosen-model');
    expect(kernel.provider().model).toBe('chosen-model');
    // ...and only once thereafter.
    expect(factoryCalls).toHaveLength(1);
  });

  it('hands a provider its providerConfig slice and prices calls at its declared price', async () => {
    let received: Record<string, unknown> | undefined;
    const providerPlugin: Plugin = {
      name: 'p',
      apiVersion: PLUGIN_API_VERSION,
      providers: [
        {
          id: 'local',
          defaultModel: 'gpt-4o',
          apiKeyEnvVar: 'NONE',
          create: (options) => {
            received = options.settings;
            // Named like a hosted model yet declared free: the declared price wins.
            return { ...makeFakeProvider({ model: 'gpt-4o' }), price: { input: 0, output: 0 } };
          },
        },
      ],
    };

    const kernel = await Kernel.create({
      config: makeConfig({
        provider: 'local',
        providerConfig: { local: { baseUrl: 'http://box/v1' }, other: 'ignored' },
      }),
      logger: silentLogger,
      builtins: [
        providerPlugin,
        capturePlugin(async (ctx) => {
          await ctx.complete({ messages: [{ role: 'user', content: 'hi' }] });
          await ctx.streamText({ messages: [{ role: 'user', content: 'hi' }] });
        }),
      ],
    });

    await kernel.run('capture', { args: {}, options: {} });
    expect(received).toEqual({ baseUrl: 'http://box/v1' });
    expect(kernel.usage.summary()).toMatchObject({ calls: 2, costUsd: 0, unpricedModels: [] });
  });

  it('gives a provider empty settings when its providerConfig entry is not an object', async () => {
    let received: Record<string, unknown> | undefined;
    const kernel = await Kernel.create({
      config: makeConfig({ provider: 'local', providerConfig: { local: 'nonsense' } }),
      logger: silentLogger,
      builtins: [
        {
          name: 'p',
          apiVersion: PLUGIN_API_VERSION,
          providers: [
            {
              id: 'local',
              defaultModel: 'm',
              apiKeyEnvVar: 'NONE',
              create: (options) => {
                received = options.settings;
                return makeFakeProvider();
              },
            },
          ],
        },
      ],
    });
    kernel.provider();
    expect(received).toEqual({});
  });

  it('reports an unknown provider with the available ones', async () => {
    const kernel = await Kernel.create({
      config: makeConfig({ provider: 'nope' }),
      logger: silentLogger,
      builtins: [],
    });
    expect(() => kernel.provider()).toThrow(ProviderError);
    expect(() => kernel.provider()).toThrow(/Unknown provider "nope"/);
  });

  it('rejects an unknown command with a usage exit code', async () => {
    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [],
      provider: makeFakeProvider(),
    });
    await expect(kernel.run('nope', { args: {}, options: {} })).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    });
  });

  it('emits a single JSON document, merging command data with usage', async () => {
    const sink = makeSink();
    const kernel = await Kernel.create({
      config: makeConfig({ json: true }),
      logger: silentLogger,
      renderer: createRenderer({ json: true, write: sink.write }),
      builtins: [
        capturePlugin(async (ctx) => {
          await ctx.complete({ messages: [{ role: 'user', content: 'q' }] });
        }),
      ],
      provider: makeFakeProvider({ responses: ['x'] }),
    });

    await kernel.run('capture', { args: {}, options: {} });

    const parsed = JSON.parse(sink.text());
    expect(parsed).toMatchObject({ command: 'capture', exitCode: 0, ok: true });
    expect(parsed.usage.calls).toBe(1);
  });

  it('runs beforeCommand and afterCommand around the command', async () => {
    const order: string[] = [];
    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [
        {
          name: 'observer',
          apiVersion: PLUGIN_API_VERSION,
          hooks: {
            beforeCommand: ({ command }) => void order.push(`before:${command}`),
            afterCommand: ({ result }) => void order.push(`after:${result.exitCode}`),
          },
        },
        capturePlugin(() => void order.push('run')),
      ],
      provider: makeFakeProvider(),
    });

    await kernel.run('capture', { args: {}, options: {} });
    expect(order).toEqual(['before:capture', 'run', 'after:0']);
  });

  it('runs hooks in plugin load order regardless of how they were registered', async () => {
    const order: string[] = [];

    // `first` registers its hook inside setup(), which happens in a later pass
    // than `second`'s static declaration. Load order must still win.
    const first: Plugin = {
      name: 'first',
      apiVersion: PLUGIN_API_VERSION,
      setup(ctx) {
        ctx.addHooks({ reviewComments: () => void order.push('first') });
      },
    };
    const second: Plugin = {
      name: 'second',
      apiVersion: PLUGIN_API_VERSION,
      hooks: { reviewComments: () => void order.push('second') },
    };

    const kernel = await Kernel.create({
      config: makeConfig(),
      logger: silentLogger,
      builtins: [first, second],
      provider: makeFakeProvider(),
    });

    await kernel.hooks.reviewComments({ comments: [], diff: [], config: makeConfig() });
    expect(order).toEqual(['first', 'second']);
  });

  it('gives a command its own plugin settings and the loaded plugin list', async () => {
    let settings: unknown;
    let pluginNames: string[] = [];

    const kernel = await Kernel.create({
      config: makeConfig({ pluginConfig: { capture: { tuning: 42 } } }),
      logger: createLogger({ level: 'silent' }),
      builtins: [
        capturePlugin((ctx) => {
          settings = ctx.pluginConfig('capture');
          pluginNames = ctx.plugins.map((p) => p.name);
        }),
      ],
      provider: makeFakeProvider(),
    });

    await kernel.run('capture', { args: {}, options: {} });
    expect(settings).toEqual({ tuning: 42 });
    expect(pluginNames).toEqual(['capture']);
  });
});
