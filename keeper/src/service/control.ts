import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NostrEvent } from "../nostr/event.ts";

/** A message that entered a conversation: which domain and thread hold it. */
export type MessagePlace = {
  readonly domain: string;
  readonly threadKey: string;
};

/** A control command (stop, status) carried out, and the notice that answers it. */
export type ControlRecord = { readonly notice: string; readonly done: boolean };

/**
 * Keeper's control store: process-wide bookkeeping that belongs to no single
 * audience. The durable truth of conversations lives in the domain stores and
 * on the relay; this store holds positions, indexes and pending work.
 *
 * - Cursors: per-channel marks below which every event is handled. Replays
 *   start 900 s before the mark because the relay accepts `created_at` up to
 *   900 s from its own clock; every effect is idempotent by event id.
 * - Threads: which thread keys have a conversation, and in which domain, so
 *   unaddressed messages in threads Keeper is not part of never open a domain.
 * - Messages: where each message that entered a conversation lives, so a later
 *   edit or deletion reaches it, also after a restart.
 * - Retries: events whose handling failed, with their next attempt time, so a
 *   failure is retried even after a restart instead of only being logged.
 * - Controls: stop and status commands carried out, with their notices.
 *   pi-durable does not deduplicate their effects, so a replay must not repeat
 *   them. A finished row is dropped once its channel's replays cannot reach it.
 */
export class ControlStore {
  static readonly OVERLAP_SECONDS = 900;
  readonly #db: DatabaseSync;
  readonly #marks = new Map<string, number>();
  readonly #threads = new Map<string, string>();
  readonly #retries = new Set<string>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(path.join(dataDir, "control.sqlite"));
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS cursors (channel_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS threads (thread_key TEXT PRIMARY KEY, domain TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS messages (event_id TEXT NOT NULL, domain TEXT NOT NULL," +
        " thread_key TEXT NOT NULL, PRIMARY KEY (event_id, domain));" +
        "CREATE TABLE IF NOT EXISTS retries (event_id TEXT PRIMARY KEY, event TEXT NOT NULL," +
        " attempts INTEGER NOT NULL, due_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS controls (event_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL," +
        " created_at INTEGER NOT NULL, notice TEXT NOT NULL, done INTEGER NOT NULL);",
    );
    this.#db
      .prepare(
        "DELETE FROM controls WHERE done = 1 AND created_at < " +
          "(SELECT c.created_at FROM cursors c WHERE c.channel_id = controls.channel_id) - ?",
      )
      .run(ControlStore.OVERLAP_SECONDS);
    for (const row of this.#db
      .prepare("SELECT channel_id, created_at FROM cursors")
      .all()) {
      this.#marks.set(String(row.channel_id), Number(row.created_at));
    }
    for (const row of this.#db
      .prepare("SELECT thread_key, domain FROM threads")
      .all()) {
      this.#threads.set(String(row.thread_key), String(row.domain));
    }
    for (const row of this.#db.prepare("SELECT event_id FROM retries").all()) {
      this.#retries.add(String(row.event_id));
    }
  }

  /** `since` for a replay of `channelId`, or `fallback` for a channel never processed. */
  since(channelId: string, fallback: number): number {
    const mark = this.#marks.get(channelId);
    return mark === undefined
      ? fallback
      : Math.max(0, mark - ControlStore.OVERLAP_SECONDS);
  }

  /** Move a channel's mark forward; it never moves back. */
  advance(channelId: string, createdAt: number): void {
    const current = this.#marks.get(channelId);
    if (current !== undefined && current >= createdAt) return;
    this.#db
      .prepare(
        "INSERT INTO cursors (channel_id, created_at) VALUES (?, ?) " +
          "ON CONFLICT(channel_id) DO UPDATE SET created_at = MAX(created_at, excluded.created_at)",
      )
      .run(channelId, createdAt);
    this.#marks.set(channelId, createdAt);
  }

  hasThread(threadKey: string): boolean {
    return this.#threads.has(threadKey);
  }

  /** The domain of the thread's current conversation. */
  domainOfThread(threadKey: string): string | undefined {
    return this.#threads.get(threadKey);
  }

  addThread(threadKey: string, domain: string): void {
    if (this.#threads.get(threadKey) === domain) return;
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO threads (thread_key, domain) VALUES (?, ?)",
      )
      .run(threadKey, domain);
    this.#threads.set(threadKey, domain);
  }

  /** Record that messages entered a conversation of `domain` in `threadKey`. */
  addMessages(
    eventIds: readonly string[],
    domain: string,
    threadKey: string,
  ): void {
    const insert = this.#db.prepare(
      "INSERT OR IGNORE INTO messages (event_id, domain, thread_key) VALUES (?, ?, ?)",
    );
    this.#db.exec("BEGIN");
    try {
      for (const eventId of eventIds) insert.run(eventId, domain, threadKey);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every conversation a message entered: usually one, two after its channel changed audience. */
  placesOf(eventId: string): MessagePlace[] {
    return this.#db
      .prepare("SELECT domain, thread_key FROM messages WHERE event_id = ?")
      .all(eventId)
      .map((row) => ({
        domain: String(row.domain),
        threadKey: String(row.thread_key),
      }));
  }

  /** Failed attempts so far for an event, 0 if none is recorded. */
  retryAttempts(eventId: string): number {
    if (!this.#retries.has(eventId)) return 0;
    const row = this.#db
      .prepare("SELECT attempts FROM retries WHERE event_id = ?")
      .get(eventId);
    return row === undefined ? 0 : Number(row.attempts);
  }

  /** Record a failed event and when to try it again. */
  scheduleRetry(event: NostrEvent, attempts: number, dueAt: number): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO retries (event_id, event, attempts, due_at) VALUES (?, ?, ?, ?)",
      )
      .run(event.id, JSON.stringify(event), attempts, dueAt);
    this.#retries.add(event.id);
  }

  /**
   * Recorded events whose next attempt is due, oldest first. Each is leased
   * until `leaseUntil`, so it is not handed out again while it runs; a crash
   * mid-attempt leaves it due again once the lease ends.
   */
  takeDueRetries(
    now: number,
    leaseUntil: number,
    limit: number,
  ): { readonly event: NostrEvent; readonly attempts: number }[] {
    const rows = this.#db
      .prepare(
        "SELECT event, attempts FROM retries WHERE due_at <= ? ORDER BY due_at LIMIT ?",
      )
      .all(now, limit);
    const lease = this.#db.prepare(
      "UPDATE retries SET due_at = ? WHERE event_id = ?",
    );
    return rows.map((row) => {
      const event = JSON.parse(String(row.event)) as NostrEvent;
      lease.run(leaseUntil, event.id);
      return { event, attempts: Number(row.attempts) };
    });
  }

  /** Forget an event's retry record; cheap when there is none. */
  clearRetry(eventId: string): void {
    if (!this.#retries.delete(eventId)) return;
    this.#db.prepare("DELETE FROM retries WHERE event_id = ?").run(eventId);
  }

  /** A control command already carried out, with its notice and whether that was posted. */
  control(eventId: string): ControlRecord | undefined {
    const row = this.#db
      .prepare("SELECT notice, done FROM controls WHERE event_id = ?")
      .get(eventId);
    return row === undefined
      ? undefined
      : { notice: String(row.notice), done: Number(row.done) === 1 };
  }

  /** Record a control command as carried out, with the notice still to post. */
  recordControl(event: NostrEvent, channelId: string, notice: string): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO controls (event_id, channel_id, created_at, notice, done) VALUES (?, ?, ?, ?, 0)",
      )
      .run(event.id, channelId, event.created_at, notice);
  }

  /** Record that a control command's notice was posted. */
  finishControl(eventId: string): void {
    this.#db
      .prepare("UPDATE controls SET done = 1 WHERE event_id = ?")
      .run(eventId);
  }

  close(): void {
    this.#db.close();
  }
}
