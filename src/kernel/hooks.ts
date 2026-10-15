import type { Logger } from './logger.js';
import type {
  AfterCommandEvent,
  AfterModelCallEvent,
  BeforeCommandEvent,
  BeforePatchEvent,
  HookDispatcher,
  HookName,
  ModelCallEvent,
  PatchChange,
  PluginHooks,
  ReviewComment,
  ReviewCommentsEvent,
} from '../plugins/api.js';
import type { CompletionRequest } from '../providers/types.js';

interface Registration {
  plugin: string;
  hooks: PluginHooks;
  /** Plugin load order. */
  order: number;
  /** Insertion order, to break ties deterministically. */
  seq: number;
}

/**
 * Runs plugin hooks in registration order.
 *
 * Transform hooks chain: each receives the previous hook's output. Observer
 * hooks are isolated — a throwing observer is logged and skipped rather than
 * failing the command, because a logging plugin should not be able to break
 * `review`. Transform hooks are *not* isolated: if a hook that is meant to
 * filter comments throws, silently keeping the unfiltered list would be worse
 * than failing.
 */
export class HookBus implements HookDispatcher {
  private readonly registrations: Registration[] = [];
  private seq = 0;
  private sorted: Registration[] | undefined;

  constructor(private readonly logger: Logger) {}

  /**
   * `order` is the plugin's position in the load order.
   *
   * It matters because hooks arrive in two waves — statically via
   * `plugin.hooks`, then via `addHooks()` during `setup()`. Without an
   * explicit order, every `setup()`-registered hook would run after every
   * static one regardless of plugin order, so a filtering plugin loaded last
   * could be silently overridden by an earlier plugin's `setup()` hook. Hooks
   * run in plugin load order, and that is the documented contract.
   */
  add(plugin: string, hooks: PluginHooks, order = 0): void {
    this.registrations.push({ plugin, hooks, order, seq: this.seq++ });
    this.sorted = undefined;
  }

  private get ordered(): Registration[] {
    this.sorted ??= [...this.registrations].sort(
      (a, b) => a.order - b.order || a.seq - b.seq,
    );
    return this.sorted;
  }

  get size(): number {
    return this.registrations.length;
  }

  /** Which hooks each plugin implements — for `swai plugins`. */
  hookNamesByPlugin(): Map<string, HookName[]> {
    const out = new Map<string, HookName[]>();
    for (const { plugin, hooks } of this.ordered) {
      const names = Object.keys(hooks).filter(
        (key) => typeof (hooks as Record<string, unknown>)[key] === 'function',
      ) as HookName[];
      out.set(plugin, [...(out.get(plugin) ?? []), ...names]);
    }
    return out;
  }

  private async observe<E>(
    name: 'beforeCommand' | 'afterCommand' | 'afterModelCall',
    event: E,
  ): Promise<void> {
    for (const { plugin, hooks } of this.ordered) {
      const fn = hooks[name] as ((e: E) => void | Promise<void>) | undefined;
      if (!fn) continue;
      try {
        await fn.call(hooks, event);
      } catch (err) {
        this.logger.warn(
          `plugin "${plugin}" threw in ${name} and was skipped:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  async beforeCommand(event: BeforeCommandEvent): Promise<void> {
    await this.observe('beforeCommand', event);
  }

  async afterCommand(event: AfterCommandEvent): Promise<void> {
    await this.observe('afterCommand', event);
  }

  async afterModelCall(event: AfterModelCallEvent): Promise<void> {
    await this.observe('afterModelCall', event);
  }

  async beforeModelCall(event: ModelCallEvent): Promise<CompletionRequest> {
    let request = event.request;
    for (const { plugin, hooks } of this.ordered) {
      if (!hooks.beforeModelCall) continue;
      const next = await hooks.beforeModelCall({ ...event, request });
      if (next) {
        this.logger.debug(`plugin "${plugin}" rewrote the request for ${event.command}`);
        request = next;
      }
    }
    return request;
  }

  async reviewComments(event: ReviewCommentsEvent): Promise<ReviewComment[]> {
    let comments = event.comments;
    for (const { plugin, hooks } of this.ordered) {
      if (!hooks.reviewComments) continue;

      // Identity of what went in, so pass-through comments are not
      // re-attributed. A hook that merely filters the list must not end up
      // credited with everything that survived it.
      const incoming = new Set(comments);
      const next = await hooks.reviewComments({ ...event, comments });

      if (next) {
        this.logger.debug(
          `plugin "${plugin}" changed the comment list: ${comments.length} -> ${next.length}`,
        );
        comments = next.map((c) =>
          c.source || incoming.has(c) ? c : { ...c, source: plugin },
        );
      }
    }
    return comments;
  }

  async beforePatch(event: BeforePatchEvent): Promise<PatchChange[]> {
    let changes = event.changes;
    for (const { plugin, hooks } of this.ordered) {
      if (!hooks.beforePatch) continue;
      const next = await hooks.beforePatch({ ...event, changes });
      if (next) {
        this.logger.debug(
          `plugin "${plugin}" changed the patch set: ${changes.length} -> ${next.length}`,
        );
        changes = next;
      }
    }
    return changes;
  }
}
