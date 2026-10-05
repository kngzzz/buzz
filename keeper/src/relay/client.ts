import {
  Kind,
  type Filter,
  type NostrEvent,
  nowSeconds,
} from "../nostr/event.ts";
import type { Signer } from "../nostr/signer.ts";
import type { Logger } from "../log.ts";

export type PublishResult = { readonly ok: boolean; readonly message: string };

export type SubscriptionHandlers = {
  onEvent(event: NostrEvent): void;
  onEose?(): void;
  /** The relay closed the subscription for good, for example access was revoked. */
  onClosed?(reason: string): void;
};

type LiveSubscription = {
  readonly filters: () => readonly Filter[];
  readonly handlers: SubscriptionHandlers;
};

type PendingQuery = {
  readonly filters: readonly Filter[];
  readonly events: NostrEvent[];
  readonly resolve: (events: NostrEvent[]) => void;
  readonly reject: (error: Error) => void;
};

type PendingPublish = {
  readonly event: NostrEvent;
  readonly resolve: (result: PublishResult) => void;
};

export type RelayClientOptions = {
  readonly url: string;
  readonly signer: Signer;
  /** NIP-OA `auth` tag to carry in the NIP-42 event, if Keeper is admitted through an owner. */
  readonly authTag?: readonly string[];
  readonly log: Logger;
  readonly reconnect?: { readonly initialMs: number; readonly maxMs: number };
  /** Treat the connection as ready if the relay sends no AUTH challenge in this time. */
  readonly authWaitMs?: number;
};

/**
 * One NIP-01/NIP-42 connection to a Buzz relay.
 *
 * Live subscriptions survive reconnects: their filters are re-evaluated and
 * re-sent after every successful authentication, so callers can move `since`
 * forward. Publishes that were in flight when the connection dropped are sent
 * again after reconnecting; the relay deduplicates by event id.
 */
export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #live = new Map<string, LiveSubscription>();
  readonly #queries = new Map<string, PendingQuery>();
  readonly #publishes = new Map<string, PendingPublish>();
  readonly #readyListeners = new Set<() => void>();
  #socket: WebSocket | undefined;
  #ready = false;
  #stopped = true;
  #attempt = 0;
  #nextQuery = 0;
  #authEventId: string | undefined;
  #authTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #readyWaiters: (() => void)[] = [];

  constructor(options: RelayClientOptions) {
    this.#options = options;
  }

  get ready(): boolean {
    return this.#ready;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#authTimer);
    this.#ready = false;
    for (const query of this.#queries.values()) {
      query.reject(new Error("relay client stopped"));
    }
    this.#queries.clear();
    for (const pending of this.#publishes.values()) {
      pending.resolve({ ok: false, message: "relay client stopped" });
    }
    this.#publishes.clear();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
      socket.close();
    }
  }

  /** Resolve once the connection is authenticated. */
  waitReady(timeoutMs = 30_000): Promise<void> {
    if (this.#ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the relay")),
        timeoutMs,
      );
      this.#readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Called after every successful (re)authentication. */
  onReady(listener: () => void): () => void {
    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  subscribe(
    id: string,
    filters: () => readonly Filter[],
    handlers: SubscriptionHandlers,
  ): () => void {
    this.#live.set(id, { filters, handlers });
    if (this.#ready) this.#send(["REQ", id, ...filters()]);
    return () => {
      if (this.#live.delete(id) && this.#ready) this.#send(["CLOSE", id]);
    };
  }

  /** One-shot REQ: stored events until EOSE. */
  async query(
    filters: readonly Filter[],
    timeoutMs = 15_000,
  ): Promise<NostrEvent[]> {
    if (this.#stopped) throw new Error("relay client stopped");
    await this.waitReady(timeoutMs);
    const id = `q${++this.#nextQuery}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#queries.delete(id);
        this.#send(["CLOSE", id]);
        reject(new Error(`query ${id} timed out`));
      }, timeoutMs);
      this.#queries.set(id, {
        filters,
        events: [],
        resolve: (events) => {
          clearTimeout(timer);
          resolve(events);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send(["REQ", id, ...filters]);
    });
  }

  /** Publish and wait for the relay's OK. Re-sent across reconnects until answered or timed out. */
  publish(event: NostrEvent, timeoutMs = 30_000): Promise<PublishResult> {
    if (this.#stopped)
      return Promise.resolve({ ok: false, message: "relay client stopped" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#publishes.delete(event.id);
        resolve({ ok: false, message: "timed out waiting for OK" });
      }, timeoutMs);
      this.#publishes.set(event.id, {
        event,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      if (this.#ready) this.#send(["EVENT", event]);
    });
  }

  /** Fire-and-forget for ephemeral events such as typing indicators. */
  send(event: NostrEvent): void {
    if (this.#ready) this.#send(["EVENT", event]);
  }

  #connect(): void {
    if (this.#stopped) return;
    const { url, log } = this.#options;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      log.warn("relay connect failed", { error: String(error) });
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      log.info("relay connected", { url });
      this.#authTimer = setTimeout(
        () => this.#becomeReady(),
        this.#options.authWaitMs ?? 3_000,
      );
    });
    socket.addEventListener("message", (message) => {
      if (typeof message.data === "string") this.#onFrame(message.data);
    });
    socket.addEventListener("close", () => this.#onDisconnect(socket));
    socket.addEventListener("error", () => this.#onDisconnect(socket));
  }

  #onDisconnect(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#ready = false;
    this.#authEventId = undefined;
    clearTimeout(this.#authTimer);
    for (const [id, query] of this.#queries) {
      query.reject(new Error(`relay disconnected during query ${id}`));
    }
    this.#queries.clear();
    if (!this.#stopped) {
      this.#options.log.warn("relay disconnected; reconnecting");
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    const { initialMs, maxMs } = this.#options.reconnect ?? {
      initialMs: 500,
      maxMs: 30_000,
    };
    const base = Math.min(maxMs, initialMs * 2 ** this.#attempt);
    this.#attempt += 1;
    const delay = base / 2 + Math.random() * (base / 2);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #onFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;
    const [type, ...rest] = frame as [string, ...unknown[]];
    switch (type) {
      case "AUTH":
        if (typeof rest[0] === "string") this.#authenticate(rest[0]);
        return;
      case "EVENT": {
        const [subId, event] = rest as [string, NostrEvent];
        const query = this.#queries.get(subId);
        if (query !== undefined) {
          query.events.push(event);
          return;
        }
        this.#live.get(subId)?.handlers.onEvent(event);
        return;
      }
      case "EOSE": {
        const subId = rest[0] as string;
        const query = this.#queries.get(subId);
        if (query !== undefined) {
          this.#queries.delete(subId);
          this.#send(["CLOSE", subId]);
          query.resolve(query.events);
          return;
        }
        this.#live.get(subId)?.handlers.onEose?.();
        return;
      }
      case "CLOSED": {
        const [subId, reason] = rest as [string, string];
        const query = this.#queries.get(subId);
        if (query !== undefined) {
          this.#queries.delete(subId);
          query.reject(new Error(`query closed: ${reason}`));
          return;
        }
        const live = this.#live.get(subId);
        if (live === undefined) return;
        if (reason.startsWith("auth-required")) return; // re-sent after auth
        this.#live.delete(subId);
        live.handlers.onClosed?.(reason);
        return;
      }
      case "OK": {
        const [eventId, ok, message] = rest as [string, boolean, string];
        if (eventId === this.#authEventId) {
          this.#authEventId = undefined;
          if (ok) this.#becomeReady();
          else this.#options.log.error("relay rejected AUTH", { message });
          return;
        }
        const pending = this.#publishes.get(eventId);
        if (pending === undefined) return;
        if (!ok && message.startsWith("auth-required")) return; // re-sent after auth
        this.#publishes.delete(eventId);
        pending.resolve({ ok, message: message ?? "" });
        return;
      }
      case "NOTICE":
        this.#options.log.info("relay notice", { message: String(rest[0]) });
        return;
      default:
        return;
    }
  }

  #authenticate(challenge: string): void {
    clearTimeout(this.#authTimer);
    const tags: string[][] = [
      ["relay", this.#options.url],
      ["challenge", challenge],
    ];
    if (this.#options.authTag !== undefined)
      tags.push([...this.#options.authTag]);
    const event = this.#options.signer.sign({
      kind: Kind.Auth,
      created_at: nowSeconds(),
      tags,
      content: "",
    });
    this.#authEventId = event.id;
    this.#send(["AUTH", event]);
  }

  #becomeReady(): void {
    clearTimeout(this.#authTimer);
    if (this.#ready || this.#socket === undefined) return;
    this.#ready = true;
    this.#attempt = 0;
    for (const [id, live] of this.#live)
      this.#send(["REQ", id, ...live.filters()]);
    for (const pending of this.#publishes.values())
      this.#send(["EVENT", pending.event]);
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of this.#readyListeners) listener();
  }

  #send(frame: unknown[]): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }
}
