import type { Context, JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type Broker, BrokerRefusal } from "../broker/broker.ts";
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

/** Whether every part was published, or why delivery stopped for good. */
export type PublishOutcome =
  | { readonly ok: true; readonly events: readonly NostrEvent[] }
  | { readonly ok: false; readonly reason: string };

/** NIP-01 `OK` prefixes that will not change on retry. */
const PERMANENT = /^(invalid|restricted|blocked|pow):/;

/** How long temporary failures are retried before delivery is given up. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Publish each part exactly once, across crashes and retries.
 *
 * Each signed event is fixed in a durable task memo before its first publish,
 * so a rerun publishes the same id and the relay deduplicates it. It never
 * throws for a delivery failure, because an error thrown from a task phase
 * faults the task and loses the outcome:
 *
 * - A memoized event that aged past the relay's ±900 s timestamp window without
 *   being stored: the broker confirms it was not stored, and the next memo
 *   generation signs a fresh one.
 * - A temporary failure (relay down, rate limit, a failed check): retried with
 *   a durable backoff for up to a day. A closing Harness cancels the sleep, and
 *   the phase resumes after reopen.
 * - A permanent refusal, by the relay or by the broker's flow check: returned,
 *   so the caller records the failure.
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
): Promise<PublishOutcome> {
  const startedAt = await task.memo(
    `${target.name}:started`,
    task.now(),
    context,
  );
  const published: NostrEvent[] = [];
  for (const [index, template] of templates.entries()) {
    let generation = 0;
    for (let attempt = 0; ; attempt++) {
      const key = `${target.name}:${index}:${generation}`;
      const stored = await task.memo<JsonObject>(key, context);
      let signed: NostrEvent;
      if (stored === undefined) {
        try {
          signed = broker.signForChannel(
            target.domain,
            target.channelId,
            template(),
          );
        } catch (error) {
          if (error instanceof BrokerRefusal) {
            return { ok: false, reason: error.message };
          }
          throw error;
        }
        signed = fromJson(await task.memo(key, toJson(signed), context));
      } else {
        signed = fromJson(stored);
      }
      let failure: string;
      try {
        const result = await broker.publish(signed);
        if (result.ok) {
          published.push(signed);
          break;
        }
        if (result.stale === true) {
          generation += 1;
          if (generation > 3) {
            return { ok: false, reason: "could not publish after re-signing" };
          }
          continue;
        }
        if (PERMANENT.test(result.message)) {
          return { ok: false, reason: result.message };
        }
        failure = result.message;
      } catch (error) {
        failure = String(error);
      }
      if (task.now() - startedAt > GIVE_UP_AFTER_MS) {
        return { ok: false, reason: `gave up after a day: ${failure}` };
      }
      const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8));
      await task.sleep(task.now() + delayMs, context);
    }
  }
  return { ok: true, events: published };
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
