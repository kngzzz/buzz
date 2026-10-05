import type { Context, JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Broker } from "../broker/broker.ts";
import type { EventTemplate, NostrEvent } from "../nostr/event.ts";

/** The parts of a pi-durable task invocation that publishing needs. */
export type TaskEffects = {
  memo<T extends JsonValue>(
    name: string,
    context: Context,
  ): Promise<T | undefined>;
  memo<T extends JsonValue>(
    name: string,
    candidate: T,
    context: Context,
  ): Promise<T>;
  now(): number;
  /** Rejects when the invocation is cancelled, for example when the Harness closes. */
  sleep(until: number, context: Context): Promise<void>;
};

/** NIP-01 `OK` prefixes that will not change on retry. */
const PERMANENT = /^(invalid|restricted|blocked|pow):/;

/**
 * Publish each part exactly once, across crashes and retries.
 *
 * Each signed event is fixed in a durable task memo before its first publish,
 * so a rerun publishes the same id and the relay deduplicates it. Two failures
 * need care:
 *
 * - A memoized event that aged past the relay's ±900 s timestamp window without
 *   being stored: the broker confirms it was not stored, and the next memo
 *   generation signs a fresh one.
 * - A transient failure (relay down, rate limit): retried with a durable
 *   backoff, because an error thrown from a task phase would fault the task and
 *   lose the reply. A closing Harness cancels the sleep, and the phase resumes
 *   after reopen.
 */
export async function publishOnce(
  task: TaskEffects,
  broker: Broker,
  target: {
    readonly domain: string;
    readonly channelId: string;
    readonly name: string;
  },
  templates: readonly (() => EventTemplate)[],
  context: Context,
): Promise<NostrEvent[]> {
  const published: NostrEvent[] = [];
  for (const [index, template] of templates.entries()) {
    let generation = 0;
    for (let attempt = 0; ; attempt++) {
      const key = `${target.name}:${index}:${generation}`;
      const stored = await task.memo<JsonObject>(key, context);
      const signed =
        stored === undefined
          ? fromJson(
              await task.memo(
                key,
                toJson(
                  broker.signForChannel(
                    target.domain,
                    target.channelId,
                    template(),
                  ),
                ),
                context,
              ),
            )
          : fromJson(stored);
      const result = await broker.publish(signed);
      if (result.ok) {
        published.push(signed);
        break;
      }
      if (result.stale === true) {
        generation += 1;
        if (generation > 3)
          throw new Error("could not publish after re-signing");
        continue;
      }
      if (PERMANENT.test(result.message))
        throw new Error(`relay refused the message: ${result.message}`);
      const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8));
      await task.sleep(task.now() + delayMs, context);
    }
  }
  return published;
}

function toJson(event: NostrEvent): JsonObject {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function fromJson(value: JsonObject): NostrEvent {
  return value as unknown as NostrEvent;
}
