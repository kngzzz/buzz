import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NostrEvent } from "../nostr/event.ts";

/**
 * Keeper's control store: process-wide bookkeeping that belongs to no single
 * audience. Cursors and threads are positions and indexes; the durable truth
 * of conversations lives in the domain stores and on the relay.
 *
 * - Cursors: per-channel high-water marks of processed events. Replays start
 *   900 s before the mark because the relay accepts `created_at` up to 900 s
 *   from its own clock; every effect is idempotent by event id.
 * - Threads: which thread keys have a conversation, so unaddressed messages in
 *   threads Keeper is not part of never open a domain.
 * - Retries: events whose handling failed, with their next attempt time, so a
 *   failure is retried even after a restart instead of only being logged.
 * - Handled: control commands (stop, status) already carried out. Their effects
 *   are not deduplicated by pi-durable, so a replay must not repeat them. A row
 *   is dropped once its channel's replays can no longer reach it.
 */
export class ControlStore {
  static readonly OVERLAP_SECONDS = 900;
  readonly #db: DatabaseSync;
  readonly #marks = new Map<string, number>();
  readonly #threads = new Map<string, string>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(path.join(dataDir, "control.sqlite"));
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS cursors (channel_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS threads (thread_key TEXT PRIMARY KEY, domain TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS retries (event_id TEXT PRIMARY KEY, event TEXT NOT NULL," +
        " attempts INTEGER NOT NULL, due_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS handled (event_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL," +
        " created_at INTEGER NOT NULL);",
    );
    this.#db
      .prepare(
        "DELETE FROM handled WHERE created_at < " +
          "(SELECT c.created_at FROM cursors c WHERE c.channel_id = handled.channel_id) - ?",
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
  }

  /** `since` for a replay of `channelId`, or `fallback` for a channel never processed. */
  since(channelId: string, fallback: number): number {
    const mark = this.#marks.get(channelId);
    return mark === undefined
      ? fallback
      : Math.max(0, mark - ControlStore.OVERLAP_SECONDS);
  }

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

  /** Failed attempts so far for an event, 0 if none is recorded. */
  retryAttempts(eventId: string): number {
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
  }

  /** Recorded events whose next attempt is due, oldest first. */
  dueRetries(now: number, limit: number): NostrEvent[] {
    return this.#db
      .prepare(
        "SELECT event FROM retries WHERE due_at <= ? ORDER BY due_at LIMIT ?",
      )
      .all(now, limit)
      .map((row) => JSON.parse(String(row.event)) as NostrEvent);
  }

  clearRetry(eventId: string): void {
    this.#db.prepare("DELETE FROM retries WHERE event_id = ?").run(eventId);
  }

  /** Whether a control command was already carried out. */
  handled(eventId: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM handled WHERE event_id = ?")
        .get(eventId) !== undefined
    );
  }

  /** Record a control command as carried out, after it succeeded. */
  markHandled(event: NostrEvent, channelId: string): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO handled (event_id, channel_id, created_at) VALUES (?, ?, ?)",
      )
      .run(event.id, channelId, event.created_at);
  }

  close(): void {
    this.#db.close();
  }
}
