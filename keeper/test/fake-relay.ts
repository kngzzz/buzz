import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { verifyEvent } from "nostr-tools";
import { WebSocket, WebSocketServer } from "ws";
import {
  type EventTemplate,
  type Filter,
  Kind,
  type NostrEvent,
  nowSeconds,
} from "../src/nostr/event.ts";
import { Signer } from "../src/nostr/signer.ts";

type Connection = {
  readonly socket: WebSocket;
  readonly challenge: string;
  pubkey: string | undefined;
  readonly subs: Map<string, readonly Filter[]>;
};

/**
 * Minimal Buzz-shaped relay for tests: NIP-42 challenge on connect,
 * `auth-required` until authenticated, signature checks, dedupe by id, stored
 * history before EOSE, and live fan-out. It does not enforce channel access.
 */
export class FakeRelay {
  readonly relaySigner = Signer.parse("1".repeat(64));
  readonly #server: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #events: NostrEvent[] = [];
  readonly #waiters: {
    predicate: (e: NostrEvent) => boolean;
    resolve: (e: NostrEvent) => void;
  }[] = [];
  /** Reject EVENTs for which this returns a message. */
  reject: ((event: NostrEvent) => string | undefined) | undefined;
  /** Accept but never answer EVENTs for which this returns true (simulates a lost OK). */
  swallowOk: ((event: NostrEvent) => boolean) | undefined;
  /** Close REQs for which this returns a reason instead of answering them. */
  failQuery: ((filters: readonly Filter[]) => string | undefined) | undefined;
  /** Every valid EVENT a client sent, duplicates included. */
  readonly received: NostrEvent[] = [];

  private constructor(server: WebSocketServer) {
    this.#server = server;
    server.on("connection", (socket) => this.#accept(socket));
  }

  static async start(): Promise<FakeRelay> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    return new FakeRelay(server);
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  get events(): readonly NostrEvent[] {
    return this.#events;
  }

  eventsOf(pubkey: string, kind?: number): NostrEvent[] {
    return this.#events.filter(
      (event) =>
        event.pubkey === pubkey && (kind === undefined || event.kind === kind),
    );
  }

  /** Store and fan out an event as if a client had published it. */
  inject(
    signer: Signer,
    template: Omit<EventTemplate, "created_at"> & { created_at?: number },
  ): NostrEvent {
    const event = signer.sign({ created_at: nowSeconds(), ...template });
    this.#store(event);
    return event;
  }

  /** Create a channel's relay-signed metadata (39000) and member list (39002). */
  channel(options: {
    id?: string;
    name: string;
    visibility?: "open" | "private";
    type?: "stream" | "forum" | "dm";
    members: readonly string[];
  }): string {
    const id = options.id ?? randomUUID();
    const tags: string[][] = [
      ["d", id],
      ["name", options.name],
    ];
    tags.push([
      options.visibility === "private" || options.type === "dm"
        ? "private"
        : "public",
    ]);
    if (options.type === "dm") tags.push(["hidden"]);
    tags.push(["t", options.type ?? "stream"]);
    this.inject(this.relaySigner, {
      kind: Kind.ChannelMetadata,
      tags,
      content: "",
    });
    this.setMembers(id, options.members);
    return id;
  }

  setMembers(channelId: string, members: readonly string[]): NostrEvent {
    return this.inject(this.relaySigner, {
      kind: Kind.ChannelMembers,
      tags: [
        ["d", channelId],
        ["h", channelId],
        ...members.map((member) => ["p", member]),
      ],
      content: "",
    });
  }

  waitFor(
    predicate: (event: NostrEvent) => boolean,
    timeoutMs = 10_000,
  ): Promise<NostrEvent> {
    const found = this.#events.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for event")),
        timeoutMs,
      );
      this.#waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  /** Drop every connection, as a relay restart or network blip would. */
  dropConnections(): void {
    for (const connection of this.#connections) connection.socket.terminate();
    this.#connections.clear();
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      challenge: randomUUID(),
      pubkey: undefined,
      subs: new Map(),
    };
    this.#connections.add(connection);
    socket.on("close", () => this.#connections.delete(connection));
    socket.on("message", (data) => this.#onFrame(connection, String(data)));
    socket.send(JSON.stringify(["AUTH", connection.challenge]));
  }

  #onFrame(connection: Connection, raw: string): void {
    const frame = JSON.parse(raw) as [string, ...unknown[]];
    const send = (value: unknown[]) => {
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(JSON.stringify(value));
      }
    };
    switch (frame[0]) {
      case "AUTH": {
        const event = frame[1] as NostrEvent;
        const challenge = event.tags.find((tag) => tag[0] === "challenge")?.[1];
        const ok =
          verify(event) &&
          event.kind === Kind.Auth &&
          challenge === connection.challenge;
        if (ok) connection.pubkey = event.pubkey;
        send(["OK", event.id, ok, ok ? "" : "auth-required: bad auth"]);
        return;
      }
      case "REQ": {
        const [, subId, ...filters] = frame as [string, string, ...Filter[]];
        if (connection.pubkey === undefined) {
          send(["CLOSED", subId, "auth-required: authenticate first"]);
          return;
        }
        const failure = this.failQuery?.(filters);
        if (failure !== undefined) {
          send(["CLOSED", subId, failure]);
          return;
        }
        for (const filter of filters) {
          let matching = this.#events.filter((event) => matches(filter, event));
          matching.sort((a, b) => b.created_at - a.created_at);
          if (filter.limit !== undefined)
            matching = matching.slice(0, filter.limit);
          for (const event of matching) send(["EVENT", subId, event]);
        }
        send(["EOSE", subId]);
        connection.subs.set(subId, filters);
        return;
      }
      case "CLOSE":
        connection.subs.delete(frame[1] as string);
        return;
      case "EVENT": {
        const event = frame[1] as NostrEvent;
        if (connection.pubkey === undefined) {
          send(["OK", event.id, false, "auth-required: authenticate first"]);
          return;
        }
        if (!verify(event) || event.pubkey !== connection.pubkey) {
          send(["OK", event.id, false, "invalid: bad signature or author"]);
          return;
        }
        this.received.push(event);
        const rejection = this.reject?.(event);
        if (rejection !== undefined) {
          send(["OK", event.id, false, rejection]);
          return;
        }
        const duplicate = this.#events.some((stored) => stored.id === event.id);
        if (!duplicate) this.#store(event);
        if (this.swallowOk?.(event)) return;
        send([
          "OK",
          event.id,
          true,
          duplicate ? "duplicate: already have this event" : "",
        ]);
        return;
      }
      default:
        return;
    }
  }

  #store(event: NostrEvent): void {
    const ephemeral = event.kind >= 20000 && event.kind < 30000;
    if (!ephemeral) this.#events.push(event);
    for (const connection of this.#connections) {
      for (const [subId, filters] of connection.subs) {
        if (filters.some((filter) => matches(filter, event))) {
          connection.socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    }
    for (let index = this.#waiters.length - 1; index >= 0; index--) {
      const waiter = this.#waiters[index];
      if (waiter?.predicate(event)) {
        this.#waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
  }
}

function verify(event: NostrEvent): boolean {
  return verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0]);
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey))
    return false;
  if (!filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  if (
    filter.search !== undefined &&
    !event.content.toLowerCase().includes(filter.search.toLowerCase())
  ) {
    return false;
  }
  for (const name of ["h", "p", "e", "d"] as const) {
    const wanted = filter[`#${name}`];
    if (wanted === undefined) continue;
    if (
      !event.tags.some(
        (tag) =>
          tag[0] === name && tag[1] !== undefined && wanted.includes(tag[1]),
      )
    ) {
      return false;
    }
  }
  return true;
}
