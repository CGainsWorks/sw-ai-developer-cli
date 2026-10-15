# Writing a plugin

Everything `swai` does is a plugin. `generate`, `review` and `explain` are not
special cases the plugin API imitates — they are written against this exact
interface, and `--disable-plugin review` removes `swai review` entirely. If
something is possible for a built-in command, it is possible for yours.

```
swai --plugin ./my-plugin.mjs my-command
```

---

## Contents

- [The smallest useful plugin](#the-smallest-useful-plugin)
- [The plugin object](#the-plugin-object)
- [Commands](#commands)
- [The command context](#the-command-context)
- [Calling a model](#calling-a-model)
- [Prompt templates](#prompt-templates)
- [Hooks](#hooks)
- [Contributing a provider](#contributing-a-provider)
- [Configuration](#configuration)
- [Loading and distribution](#loading-and-distribution)
- [Rules and limits](#rules-and-limits)
- [Two worked examples](#two-worked-examples)

---

## The smallest useful plugin

A plugin is a plain object. It does not have to import anything, which is why a
`.mjs` file with no build step and no dependencies works:

```js
// my-plugin.mjs
export default {
  name: 'hello',
  apiVersion: 1,
  commands: [
    {
      name: 'hello',
      description: 'Say hello',
      args: [{ name: 'who', description: 'Who to greet' }],
      run(ctx) {
        ctx.out.line(`hello ${ctx.args.who ?? 'world'}`);
        return { exitCode: 0, data: { greeted: ctx.args.who ?? 'world' } };
      },
    },
  ],
};
```

```
$ swai --plugin ./my-plugin.mjs hello reviewer
hello reviewer
```

In TypeScript, `definePlugin` gives you type-checking without a cast:

```ts
import { definePlugin, PLUGIN_API_VERSION } from 'sw-ai-developer-cli/plugin';

export default definePlugin({
  name: 'hello',
  apiVersion: PLUGIN_API_VERSION,
  commands: [/* ... */],
});
```

---

## The plugin object

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique. Keys `pluginConfig`, and is what `--disable-plugin` takes. |
| `apiVersion` | yes | Must equal `PLUGIN_API_VERSION` (currently `1`). |
| `version` | no | Shown by `swai plugins`. |
| `description` | no | Shown by `swai plugins`. |
| `commands` | no | Commands to register. |
| `providers` | no | Model providers to register. |
| `hooks` | no | Hooks into other commands. |
| `setup(ctx)` | no | Runs after all plugins are registered, before any command executes. |

`apiVersion` is checked, not advisory: a plugin declaring a different version is
refused with an explanation rather than half-loaded.

### `setup()`

Use `setup()` when registration depends on configuration, or on what other
plugins contributed. It runs in a second pass, after every plugin's static
`commands`/`providers`/`hooks` are in place, so `setup()` can see them.

```js
setup(ctx) {
  ctx.logger.debug('starting up');            // prefixed with your plugin name
  if (ctx.settings.strict) {                   // pluginConfig["<your name>"]
    ctx.addHooks({ reviewComments: escalateEverything });
  }
  ctx.registerCommand({ /* ... */ });
  ctx.registerProvider({ /* ... */ });
}
```

---

## Commands

```ts
interface CommandSpec {
  name: string;
  description: string;
  args?: ArgSpec[];       // positionals, in order
  options?: OptionSpec[];  // flags
  examples?: string[];     // appended to --help
  run(ctx): CommandResult | Promise<CommandResult>;
}
```

### Arguments

```js
args: [
  { name: 'file',  description: 'File to read', required: true },
  { name: 'extra', description: 'Anything else', variadic: true },
]
```

A `variadic` argument collects every remaining positional into an array and
must be declared last. `ctx.args.file` is a `string`; `ctx.args.extra` is a
`string[]`.

### Options

```js
options: [
  { name: 'fail-on', description: 'Threshold', type: 'string', choices: ['info', 'warning', 'error'] },
  { name: 'count',   short: 'n', description: 'How many', type: 'number', default: 3 },
  { name: 'quiet',   short: 'q', description: 'Be quiet', type: 'boolean' },
  { name: 'include', description: 'Repeatable', type: 'string[]' },
]
```

- Long names are kebab-case on the command line and **camelCase in
  `ctx.options`**: `--fail-on` arrives as `ctx.options.failOn`.
- `--flag=value`, `--flag value`, `-n 3` and `-n=3` all work.
- A `boolean` option can be turned off again with `--no-<name>`.
- `choices` and `type` are validated before `run()` is called, so your command
  never has to defend against a bad flag value.
- Reading options: `getString`, `getNumber`, `getBoolean` and `getStringArray`
  are exported for this, and return `undefined` rather than throwing on a
  wrong-typed value.

### The result

```ts
return {
  exitCode: 0,                   // see the exit-code table in the README
  data: { anything: 'here' },    // becomes the JSON document under --json
  summary: 'what happened',      // one line, logged at debug level
};
```

Under `--json`, `data` is merged into a single document alongside `command`,
`exitCode` and `usage`. That is why `data` should be a plain object.

---

## The command context

```ts
ctx.command       // the command name being run
ctx.args          // positionals, keyed by ArgSpec.name
ctx.options       // flags, camelCased
ctx.config        // the fully resolved configuration
ctx.cwd           // working directory (honours --cwd)
ctx.signal        // AbortSignal, aborted on Ctrl-C
ctx.logger        // diagnostics — goes to stderr
ctx.out           // payload output — goes to stdout
ctx.usage         // token and cost totals so far
ctx.provider      // the resolved model provider
ctx.hooks         // dispatch hooks yourself (e.g. reviewComments)
ctx.plugins       // every loaded plugin and what it contributed
ctx.complete()    // a model call
ctx.streamText()  // a streaming model call
ctx.renderTemplate()
ctx.pluginConfig()
```

### `ctx.out` versus `ctx.logger`

`ctx.out` writes the payload to **stdout**. `ctx.logger` writes diagnostics to
**stderr**. Keeping them apart is what makes `swai review --json | jq` work
while progress messages still reach the terminal.

Under `--json`, `ctx.out.line()` and `ctx.out.text()` are suppressed
automatically — you do not need to branch, though `ctx.out.isJson` is there if
building the human output is expensive.

```js
ctx.out.line(ctx.out.bold('Findings'));  // colour helpers no-op under --no-color
ctx.logger.info('reviewing 12 files');   // never pollutes stdout
```

### `ctx.provider` is lazy

The provider is constructed on first access, not at startup. A command that
never calls a model — like `plugins` — works with no API key set.

---

## Calling a model

**Use `ctx.complete()` and `ctx.streamText()`, not `ctx.provider` directly.**
Going through the context is what runs the `beforeModelCall` / `afterModelCall`
hooks and records tokens and cost against the budget. A raw `ctx.provider.complete()`
call silently bypasses both.

```js
const result = await ctx.complete({
  system: 'You are a precise assistant.',
  messages: [{ role: 'user', content: prompt }],
  signal: ctx.signal,
});
result.text;   // string
result.usage;  // { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
result.model;  // what actually served it
```

Streaming writes to `ctx.out` as text arrives, and still returns the whole
result at the end:

```js
const result = await ctx.streamText(request, (chunk) => {
  // optional per-chunk callback; ctx.out is already being written to
});
```

### Structured output

Pass `jsonSchema` to constrain the response:

```js
const result = await ctx.complete({
  messages: [{ role: 'user', content: prompt }],
  jsonSchema: { name: 'findings', schema: MY_SCHEMA },
});
```

Not every model can be schema-constrained. When one cannot, the provider throws
`UnsupportedStructuredOutput` rather than quietly returning prose — catch it and
retry unconstrained, as the `review` command does:

```js
import { UnsupportedStructuredOutput } from 'sw-ai-developer-cli/plugin';

try {
  return extractJson((await ctx.complete({ ...req, jsonSchema })).text);
} catch (err) {
  if (!(err instanceof UnsupportedStructuredOutput)) throw err;
  return extractJson((await ctx.complete(req)).text);
}
```

Because OpenAI's strict mode requires every declared property to appear in
`required`, express optional fields as a nullable union rather than omitting
them:

```json
{ "suggestion": { "anyOf": [{ "type": "string" }, { "type": "null" }] } }
```

---

## Prompt templates

Prompts live as Markdown files with `{{placeholder}}` substitution, so they can
be read and overridden without touching code.

```js
const prompt = await ctx.renderTemplate('review', { diff, extraInstructions: '' });
```

Resolution order is `templatesDir` from config, then the packaged `templates/`
directory — so a project can override one template without vendoring them all.
An unfilled placeholder is an error, not an empty string: a prompt that silently
loses its input produces a confidently wrong answer.

See [prompt_design.md](prompt_design.md) for why the shipped templates are
shaped the way they are.

---

## Hooks

Hooks let a plugin change what *other* commands do.

| Hook | Kind | Fires |
|---|---|---|
| `beforeCommand` | observer | Before a command runs |
| `afterCommand` | observer | After a command returns |
| `beforeModelCall` | **transform** | Before every model call |
| `afterModelCall` | observer | After every model call |
| `reviewComments` | **transform** | After `review` parses the model's findings |
| `beforePatch` | **transform** | Before `generate --patch` writes anything |

**Transform hooks** may return a replacement value, or return nothing to leave
the value untouched. They chain: each hook receives the previous one's output.

```js
hooks: {
  // Observer: return value ignored.
  afterModelCall({ result }) {
    metrics.record(result.usage.outputTokens);
  },

  // Transform: returning a value replaces it for every later hook.
  beforeModelCall({ request }) {
    return { ...request, system: `${request.system}\n\nProject: acme` };
  },

  // Transform: filter, escalate, or add findings.
  reviewComments({ comments, diff }) {
    return comments.filter((c) => c.category !== 'style');
  },
}
```

### Ordering and error handling

- Hooks run in **plugin load order**: built-ins first, then `--plugin` entries
  in the order given. This holds whether a hook was declared statically or
  added in `setup()`.
- A throwing **observer** hook is logged and skipped — a logging plugin must not
  be able to break `review`.
- A throwing **transform** hook fails the command. Silently keeping an
  unfiltered comment list would be worse than stopping.
- Findings you add without a `source` are attributed to your plugin
  automatically. Findings you merely pass through keep their original source.

---

## Contributing a provider

Implement `Provider` and register a `ProviderFactory`. Nothing above the
provider layer knows which model it is talking to, so a new provider needs no
changes to any command.

```js
providers: [
  {
    id: 'my-provider',
    defaultModel: 'my-model-1',
    apiKeyEnvVar: 'MY_PROVIDER_API_KEY',
    create({ model, maxTokens, timeoutMs, settings }) {
      return {
        id: 'my-provider',
        model: model ?? 'my-model-1',
        async complete(request) {
          return { text: '...', model: 'my-model-1', usage: { inputTokens: 0, outputTokens: 0 } };
        },
        async *stream(request) {
          yield { type: 'text', text: 'partial' };
          yield { type: 'done', result: { /* as above */ } };
        },
      };
    },
  },
],
```

Then: `swai --provider my-provider review`.

Report real token counts in `usage` if you can. Add a `pricing` entry in config
for your model, or `swai` reports its cost as `unknown` — which is deliberate,
because an unknown cost must never be displayed as a free one.

A provider that knows its own cost can say so by setting `price` (USD per 1M
tokens) on the object `create()` returns. That price is used instead of the
built-in table; a `pricing` entry in the config still overrides it. The
built-in `compat` provider uses this to report self-hosted models as genuinely
free rather than unknown.

`settings` is your provider's slice of `providerConfig` in the config file,
keyed by provider id, so users can configure it without environment variables:

```json
{
  "provider": "my-provider",
  "providerConfig": {
    "my-provider": { "region": "eu-west-1" }
  }
}
```

If your service speaks the OpenAI Chat Completions format, you may not need a
plugin at all: the built-in `compat` provider takes a base URL, a model name and
the name of a key variable.

`examples/plugins/stub-provider.mjs` is a complete working provider plugin; it
is what `make demo` runs.

---

## Configuration

Your plugin's settings live under your plugin name:

```json
{
  "plugins": ["./my-plugin.mjs"],
  "pluginConfig": {
    "my-plugin": { "strict": true, "threshold": 5 }
  }
}
```

Read them in `setup()` as `ctx.settings`, or in a command as
`ctx.pluginConfig('my-plugin')`. Relative plugin paths in a config file resolve
against **that file**, not the working directory.

---

## Loading and distribution

`--plugin` accepts:

| Form | Resolved as |
|---|---|
| `./plugins/mine.js` | Relative to the config file, or to `--cwd` |
| `/abs/path/mine.js` | As given |
| `swai-plugin-mine` | A package in the project's `node_modules` |

The module may export the plugin as `default` or as a named `plugin`, or export
a factory function under either name that returns one.

To publish: `"name": "swai-plugin-<something>"`, add `sw-ai-developer-cli` as a
peer dependency, and point `exports` at your built file. Users then add it to
`plugins` in their config.

---

## Rules and limits

These are enforced at load time, so a mistake is an error at startup rather
than a puzzle at runtime:

- `apiVersion` must match exactly.
- Two plugins cannot register the same command name or provider id.
- A `variadic` argument must be the last one declared.
- A command option cannot use a reserved global flag name — `--verbose`,
  `--json`, `--model` and the rest. Global flags are stripped from argv before
  a command's parser runs, so such an option could never receive a value. The
  full list is exported as `RESERVED_OPTION_NAMES`.

---

## Two worked examples

Both ship with the CLI, and both are written against this document — read them
next to it.

### `conventional-commits` — contributing a command

[`src/plugins/builtin/conventional-commits.ts`](../src/plugins/builtin/conventional-commits.ts)

Adds `swai commit-msg`: reads the staged diff, renders a template, calls the
model, then validates the result against the Conventional Commits grammar and
exits `5` if it does not conform. Shows commands, options, `pluginConfig`, and
returning a non-zero exit code for a *content* problem rather than an error.

### `review-policy` — hooks only, no command

[`src/plugins/builtin/review-policy.ts`](../src/plugins/builtin/review-policy.ts)

Registers a single `reviewComments` hook that:

1. **Adds** deterministic findings a model is unreliable at — `debugger`,
   `console.log`, hardcoded credentials, focused tests. These are grep rules;
   putting them through an LLM would be slower, costlier and less repeatable.
2. **Escalates or demotes** findings by category.
3. **Drops** categories the project does not care about and caps per-file noise.

It is the argument for hooks in one file: none of that needed a fork of the
`review` command, and all of it is configurable per project.
