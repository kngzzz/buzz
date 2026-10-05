import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, UserMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type EntryId,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type SubmissionId,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { buildAgent, type KeeperAgent } from "../agent/agent.ts";
import { ResearchJobsDoc } from "../agent/research.ts";
import type { AgentServices, SearchProvider } from "../agent/services.ts";
import { Broker } from "../broker/broker.ts";
import { Directory } from "../broker/directory.ts";
import type { Logger } from "../log.ts";
import { safeFetch } from "../net/safe-fetch.ts";
import {
  CHANNEL_KINDS,
  channelOf,
  type Filter,
  Kind,
  MESSAGE_KINDS,
  type NostrEvent,
  nowSeconds,
  replyTags,
  tagValue,
} from "../nostr/event.ts";
import type { Signer } from "../nostr/signer.ts";
import { RelayClient } from "../relay/client.ts";
import {
  BuzzMessageEntry,
  HistoryDoc,
  RequestsDoc,
  type ThreadState,
} from "../runtime/docs.ts";
import { Domain, type HistoryEntry } from "../runtime/domain.ts";
import { renderMessage } from "../runtime/render.ts";
import { ControlStore } from "./control.ts";
import {
  type Control,
  type Route,
  route,
  type ThreadRef,
  threadOf,
} from "./router.ts";

/** Attempts at handling one event before Keeper gives up and tells the thread. */
const MAX_ATTEMPTS = 6;
/** Attempts at that last notice before the event is dropped with an error log. */
const MAX_APOLOGY_ATTEMPTS = 3;
/**
 * Stored events per page when catching up. The relay's own limit is 1,000, so
 * a page this size coming back full means older events may be waiting.
 */
const CATCH_UP_PAGE = 500;
/** A domain with nothing live is closed after this long without use. */
const DOMAIN_IDLE_MS = 10 * 60 * 1000;
/** Research jobs listed by `status`, newest first. */
const STATUS_JOBS = 5;

export type KeeperOptions = {
  readonly relayUrl: string;
  readonly signer: Signer;
  /** NIP-OA auth tag, when Keeper is admitted through an owner rather than as a member. */
  readonly authTag?: readonly string[];
  readonly dataDir: string;
  readonly name: string;
  readonly about: string;
  readonly models: Models;
  readonly model: ModelRef;
  readonly researchModel?: ModelRef;
  readonly search?: SearchProvider;
  readonly fetchPage?: AgentServices["fetchPage"];
  /** Agents allowed to wake Keeper; all other agents are ignored as triggers. */
  readonly allowedAgents?: ReadonlySet<string>;
  readonly settings?: HarnessSettings;
  readonly log: Logger;
  /** How far back to look in a channel Keeper has never processed, in seconds. */
  readonly initialLookbackSeconds?: number;
  readonly typingIntervalMs?: number;
  /** First retry delay for an event whose handling failed; doubles per attempt. */
  readonly retryBaseMs?: number;
};

/** What a queued event is for: handling it, or the last notice after handling kept failing. */
type Mode = "handle" | "apologize";

/**
 * The research agent service: connects to one community's relay, listens in
 * the channels Keeper belongs to, turns requests into durable conversations,
 * and posts every answer exactly once through reply tasks.
 */
export class Keeper {
  readonly #options: KeeperOptions;
  readonly #context: Context = BACKGROUND_CONTEXT;
  readonly #relay: RelayClient;
  readonly #directory = new Directory();
  readonly #broker: Broker;
  readonly #agent: KeeperAgent;
  readonly #control: ControlStore;
  readonly #domains = new Map<string, Promise<Domain>>();
  /** Domains being closed; reopening one waits for its close. */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #lastUsed = new Map<string, number>();
  readonly #seen = new BoundedSet(20_000);
  /** Recent message id → thread key, so an edit queues behind the message it changes. */
  readonly #messageThreads = new BoundedMap<string, string>(50_000);
  readonly #queues = new Map<string, Promise<void>>();
  /** Per channel: events taken but not settled (id → `created_at`); the cursor stays below them. */
  readonly #inflight = new Map<string, Map<string, number>>();
  /** Per channel: the newest settled event, the cursor's next mark when nothing older is in flight. */
  readonly #settledMarks = new Map<string, number>();
  readonly #dirtyCursors = new Set<string>();
  readonly #startedAt = nowSeconds();
  /** The relay's key, learned from the member lists it returned; only it may change the directory. */
  #relayKey: string | undefined;
  #channelSubscriptions: (() => void)[] = [];
  #subscriptionGeneration = 0;
  /** A rediscovery after the relay refused a subscription, at most one at a time. */
  #rediscovery: ReturnType<typeof setTimeout> | undefined;
  #timers: ReturnType<typeof setInterval>[] = [];
  #stopped = false;

  private constructor(options: KeeperOptions) {
    this.#options = options;
    this.#relay = new RelayClient({
      url: options.relayUrl,
      signer: options.signer,
      ...(options.authTag === undefined ? {} : { authTag: options.authTag }),
      log: options.log,
    });
    this.#broker = new Broker({
      signer: options.signer,
      relay: this.#relay,
      directory: this.#directory,
      log: options.log,
    });
    this.#agent = buildAgent(
      {
        name: options.name,
        broker: this.#broker,
        directory: this.#directory,
        researchModel: options.researchModel,
        search: options.search,
        fetchPage:
          options.fetchPage ??
          ((url, signal) =>
            safeFetch(url, signal === undefined ? {} : { signal })),
        log: options.log,
      },
      this.#broker,
    );
    this.#control = new ControlStore(options.dataDir);
  }

  static async start(options: KeeperOptions): Promise<Keeper> {
    const keeper = new Keeper(options);
    await keeper.#start();
    return keeper;
  }

  get pubkey(): string {
    return this.#broker.pubkey;
  }

  async #start(): Promise<void> {
    const { log } = this.#options;
    this.#relay.start();
    await this.#relay.waitReady(60_000);
    await this.#broker.publishProfile({
      name: this.#options.name,
      about: this.#options.about,
    });
    await this.#discoverChannels();
    await this.#resumeDomains();
    this.#subscribeOrdered("keeper-membership", () => ({
      kinds: [Kind.MemberAdded, Kind.MemberRemoved],
      "#p": [this.pubkey],
      since: this.#startedAt - 60,
    }));
    this.#subscribeChannels();
    const tick = Math.min(1_000, this.#options.retryBaseMs ?? 2_000);
    this.#timers = [
      setInterval(() => {
        this.#pumpRetries();
        this.#saveCursors();
      }, tick),
      setInterval(() => void this.#sweepDomains(), 60_000),
    ];
    for (const timer of this.#timers) timer.unref();
    log.info("keeper started", {
      pubkey: this.pubkey,
      channels: this.#directory.all().length,
      domains: this.#domains.size,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    clearTimeout(this.#rediscovery);
    for (const unsubscribe of this.#channelSubscriptions) unsubscribe();
    await Promise.allSettled([...this.#queues.values()]);
    this.#saveCursors();
    await this.#relay.stop();
    await Promise.allSettled([...this.#closing.values()]);
    for (const domain of this.#domains.values()) {
      await (await domain).close(this.#context).catch(() => {});
    }
    this.#domains.clear();
    this.#control.close();
  }

  // ─── Channels and membership ──────────────────────────────────────────────

  /** Rebuild the channel list from the relay: the channels whose member lists name Keeper. */
  async #discoverChannels(): Promise<void> {
    const { events: memberLists, complete } = await this.#relay.queryAll({
      kinds: [Kind.ChannelMembers],
      "#p": [this.pubkey],
    });
    if (!complete) {
      this.#options.log.warn("channel discovery stopped at its page limit");
    }
    const ids: string[] = [];
    for (const event of memberLists) {
      this.#relayKey ??= event.pubkey;
      if (event.pubkey !== this.#relayKey) continue;
      this.#directory.apply(event);
      const id = tagValue(event, "d");
      if (id !== undefined) ids.push(id);
    }
    if (complete) {
      const current = new Set(ids);
      for (const channel of this.#directory.all()) {
        if (!current.has(channel.id)) this.#directory.delete(channel.id);
      }
    }
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      for (const event of await this.#relay.query([
        { kinds: [Kind.ChannelMetadata], "#d": batch },
      ])) {
        this.#directory.apply(event);
      }
    }
  }

  async #onMembership(event: NostrEvent): Promise<void> {
    const channelId = tagValue(event, "h");
    if (channelId === undefined) return;
    if (event.kind === Kind.MemberRemoved) {
      this.#directory.delete(channelId);
      this.#options.log.info("removed from channel", { channelId });
    } else {
      const events = await this.#relay.query([
        {
          kinds: [Kind.ChannelMetadata, Kind.ChannelMembers],
          "#d": [channelId],
        },
      ]);
      for (const metadata of events) {
        this.#relayKey ??= metadata.pubkey;
        this.#directory.apply(metadata);
      }
      this.#control.advance(channelId, event.created_at);
      this.#options.log.info("added to channel", { channelId });
    }
    this.#subscribeChannels();
  }

  #subscribeChannels(): void {
    for (const unsubscribe of this.#channelSubscriptions) unsubscribe();
    this.#channelSubscriptions = [];
    const generation = ++this.#subscriptionGeneration;
    const ids = this.#directory
      .all()
      .filter((channel) => !channel.archived)
      .map((channel) => channel.id);
    const fallback =
      this.#startedAt - (this.#options.initialLookbackSeconds ?? 60);
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      this.#channelSubscriptions.push(
        this.#subscribeOrdered(
          `keeper-channels-${generation}-${start / 100}`,
          () => ({
            kinds: CHANNEL_KINDS,
            "#h": batch,
            since: Math.min(
              ...batch.map((id) => this.#control.since(id, fallback)),
            ),
          }),
          // One REQ serves the whole batch from its oldest channel's window.
          // Events older than their own channel's window were handled, and
          // the records that deduplicate them may be gone, so they stop here.
          (event) => {
            const channelId = channelOf(event) ?? tagValue(event, "d");
            return (
              channelId === undefined ||
              event.created_at >= this.#control.since(channelId, fallback)
            );
          },
        ),
      );
    }
  }

  /**
   * Subscribe so stored events reach `#enqueue` oldest first. The relay sends
   * them newest first and at most a page at a time, so they are held until
   * EOSE, the older ones are paged in when the page came back full, and the
   * lot is sorted; then live events pass straight through. Every REQ, also the
   * one after a reconnect, starts this over. When paging fails, the REQ is sent
   * again later rather than handing on a catch-up with a hole in it.
   */
  #subscribeOrdered(
    id: string,
    filter: () => Filter,
    accept: (event: NostrEvent) => boolean = () => true,
  ): () => void {
    let held: NostrEvent[] | undefined = [];
    let request = 0;
    let current: Filter | undefined;
    let failures = 0;
    // The relay's page as it came, before `accept`: whether to page back
    // depends on how full it was, not on what was kept.
    let stored = 0;
    let oldest = Number.POSITIVE_INFINITY;
    return this.#relay.subscribe(
      id,
      () => {
        current = { ...filter(), limit: CATCH_UP_PAGE };
        return [current];
      },
      {
        onRequest: () => {
          request += 1;
          held = [];
          stored = 0;
          oldest = Number.POSITIVE_INFINITY;
        },
        onEvent: (event) => {
          if (held !== undefined) {
            stored += 1;
            oldest = Math.min(oldest, event.created_at);
          }
          if (!accept(event)) return;
          if (held === undefined) this.#enqueue(event);
          else held.push(event);
        },
        onEose: () => {
          const mine = request;
          const asked = current;
          if (held === undefined || asked === undefined) return;
          const paging =
            stored < CATCH_UP_PAGE
              ? Promise.resolve([])
              : this.#olderThan(oldest, asked);
          void paging.then(
            (older) => {
              if (mine !== request || held === undefined) return;
              const events = [...older.filter(accept), ...held];
              held = undefined;
              failures = 0;
              events.sort(
                (a, b) =>
                  a.created_at - b.created_at ||
                  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
              );
              for (const event of events) this.#enqueue(event);
            },
            (error: unknown) => {
              failures += 1;
              const delayMs = Math.min(60_000, 1_000 * 2 ** failures);
              this.#options.log.warn("catch-up failed; starting it over", {
                id,
                delayMs,
                error: String(error),
              });
              setTimeout(() => {
                if (mine === request && !this.#stopped) this.#relay.refresh(id);
              }, delayMs).unref();
            },
          );
        },
        onClosed: (reason) => {
          this.#options.log.error("subscription refused by the relay", {
            id,
            reason,
          });
          // Usually access to a channel was revoked: rebuild the channel list.
          this.#scheduleRediscovery();
        },
      },
    );
  }

  /**
   * Rediscover channels and resubscribe, 30 s after the relay refused a
   * subscription for good; refusals in between share one rediscovery.
   */
  #scheduleRediscovery(): void {
    if (this.#stopped || this.#rediscovery !== undefined) return;
    this.#rediscovery = setTimeout(() => {
      this.#discoverChannels().then(
        () => {
          this.#rediscovery = undefined;
          this.#subscribeChannels();
        },
        (error: unknown) => {
          this.#rediscovery = undefined;
          this.#options.log.error("could not refresh channels", {
            error: String(error),
          });
          this.#scheduleRediscovery();
        },
      );
    }, 30_000);
    this.#rediscovery.unref();
  }

  /** Stored events from `until` back, for a catch-up whose first page came back full. */
  async #olderThan(until: number, filter: Filter): Promise<NostrEvent[]> {
    const { events, complete } = await this.#relay.queryAll(
      { ...filter, until },
      { pageSize: CATCH_UP_PAGE },
    );
    if (!complete) {
      this.#options.log.warn("catch-up stopped at its page limit", {
        until,
      });
    }
    return events;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * Take one relay event. Events of one thread are handled in order and
   * different threads concurrently. A failed event gets a durable retry record;
   * after the last attempt Keeper says so in the thread, so nobody waits on a
   * request that will never be answered.
   */
  #enqueue(event: NostrEvent, mode: Mode = "handle"): void {
    if (this.#stopped || this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (
      event.kind === Kind.ChannelMetadata ||
      event.kind === Kind.ChannelMembers
    ) {
      // Relay-signed facts the router and the flow checks read: applied at once.
      if (this.#relayKey === undefined || event.pubkey === this.#relayKey) {
        this.#directory.apply(event);
      }
      return;
    }
    const channelId = CHANNEL_KINDS.includes(event.kind)
      ? channelOf(event)
      : undefined;
    if (channelId !== undefined)
      this.#inflightOf(channelId).set(event.id, event.created_at);
    const key = this.#queueKeyOf(event);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() =>
        mode === "handle" ? this.#handle(event) : this.#apologize(event),
      )
      .then(
        () => this.#settled(event, mode, undefined),
        (error: unknown) => this.#settled(event, mode, error ?? "error"),
      )
      .finally(() => {
        if (channelId !== undefined) this.#release(channelId, event);
      });
    this.#queues.set(key, next);
    void next.finally(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
  }

  /**
   * Messages queue on their thread; edits and deletions on their target's
   * thread, so they apply after the message they change.
   */
  #queueKeyOf(event: NostrEvent): string {
    if (event.kind === Kind.MemberAdded || event.kind === Kind.MemberRemoved)
      return "membership";
    const channelId = channelOf(event);
    const channel =
      channelId === undefined ? undefined : this.#directory.get(channelId);
    if (channel !== undefined && MESSAGE_KINDS.includes(event.kind)) {
      const key = threadOf(event, channel).key;
      this.#messageThreads.set(event.id, key);
      return key;
    }
    const target = tagValue(event, "e");
    const targetThread =
      target === undefined
        ? undefined
        : (this.#messageThreads.get(target) ??
          this.#control.placesOf(target)[0]?.threadKey);
    return targetThread ?? `channel:${channelId ?? event.id}`;
  }

  /** Record how handling ended: clear its retry record, or schedule the next attempt. */
  #settled(event: NostrEvent, mode: Mode, error: unknown): void {
    const { log } = this.#options;
    try {
      if (error === undefined) {
        this.#control.clearRetry(event.id);
        return;
      }
      const attempts = this.#control.retryAttempts(event.id) + 1;
      const limit =
        mode === "handle" ? MAX_ATTEMPTS : MAX_ATTEMPTS + MAX_APOLOGY_ATTEMPTS;
      if (attempts < limit) {
        // The last handling attempt hands over to the apology, which starts at once.
        const step = mode === "handle" ? attempts : attempts - MAX_ATTEMPTS + 1;
        const delayMs = Math.min(
          60_000,
          (this.#options.retryBaseMs ?? 2_000) * 2 ** (step - 1),
        );
        this.#control.scheduleRetry(event, attempts, Date.now() + delayMs);
        this.#seen.delete(event.id);
        log.warn("event handling failed; will retry", {
          eventId: event.id,
          attempts,
          error: String(error),
        });
        return;
      }
      if (mode === "handle") {
        // Out of attempts: the apology is next, as a retry of its own.
        this.#control.scheduleRetry(event, MAX_ATTEMPTS, Date.now());
        this.#seen.delete(event.id);
        log.error("event handling failed; telling the thread", {
          eventId: event.id,
          attempts,
          error: String(error),
        });
        return;
      }
      // Terminal: stays in #seen, so only a restart's replay can try it again.
      this.#control.clearRetry(event.id);
      log.error("could not tell the thread about a failed request", {
        eventId: event.id,
        error: String(error),
      });
    } catch (bookkeeping) {
      log.error("could not record event outcome", {
        eventId: event.id,
        error: String(bookkeeping),
      });
    }
  }

  /** Re-enqueue failed events whose retry is due, including ones recorded before a restart. */
  #pumpRetries(): void {
    if (this.#stopped) return;
    try {
      const now = Date.now();
      for (const { event, attempts } of this.#control.takeDueRetries(
        now,
        now + 60_000,
        100,
      )) {
        this.#enqueue(event, attempts >= MAX_ATTEMPTS ? "apologize" : "handle");
      }
    } catch (error) {
      this.#options.log.error("could not read retries", {
        error: String(error),
      });
    }
  }

  /** The last word on a request Keeper could not take: say so, so the person can ask again. */
  async #apologize(event: NostrEvent): Promise<void> {
    const decision = this.#route(event);
    if (decision.type !== "request" && decision.type !== "control") return;
    await this.#notice(
      decision.thread,
      event,
      "Sorry, I couldn't take this request. Please ask me again in a moment.",
    );
  }

  #inflightOf(channelId: string): Map<string, number> {
    let events = this.#inflight.get(channelId);
    if (events === undefined) {
      events = new Map();
      this.#inflight.set(channelId, events);
    }
    return events;
  }

  #release(channelId: string, event: NostrEvent): void {
    this.#inflight.get(channelId)?.delete(event.id);
    this.#settledMarks.set(
      channelId,
      Math.max(this.#settledMarks.get(channelId) ?? 0, event.created_at),
    );
    this.#dirtyCursors.add(channelId);
  }

  /**
   * Move each channel's cursor up to the newest settled event, but never past
   * an older one still in flight: a crash replays from 900 s before the cursor,
   * which must still reach every event that was not handled.
   */
  #saveCursors(): void {
    for (const channelId of this.#dirtyCursors) {
      const settled = this.#settledMarks.get(channelId);
      if (settled === undefined) continue;
      const pending = this.#inflight.get(channelId);
      let mark = settled;
      for (const createdAt of pending?.values() ?? []) {
        mark = Math.min(mark, createdAt - 1);
      }
      try {
        this.#control.advance(channelId, mark);
      } catch (error) {
        this.#options.log.error("could not save a cursor", {
          channelId,
          error: String(error),
        });
        continue;
      }
      if (pending === undefined || pending.size === 0) {
        this.#inflight.delete(channelId);
        this.#dirtyCursors.delete(channelId);
      }
    }
  }

  #route(event: NostrEvent): Route {
    const channelId = channelOf(event) ?? tagValue(event, "d");
    return route(
      {
        event,
        self: this.pubkey,
        channel:
          channelId === undefined ? undefined : this.#directory.get(channelId),
        hasConversation: (key) => this.#control.hasThread(key),
        isAgent: (pubkey) => this.#broker.isKnownAgent(pubkey),
        allowedAgents: this.#options.allowedAgents ?? new Set(),
      },
      [this.#options.name],
    );
  }

  /** Routing happens here, in thread order, so it sees conversations earlier events created. */
  async #handle(event: NostrEvent): Promise<void> {
    if (event.kind === Kind.MemberAdded || event.kind === Kind.MemberRemoved)
      return this.#onMembership(event);
    let decision = this.#route(event);
    if (decision.type === "request" || decision.type === "control") {
      // Whether the author is an agent comes from their profile. Load it before
      // letting them wake Keeper, then decide again; the thread stays the same.
      // If the relay cannot be asked, the event is retried rather than misjudged.
      await this.#broker.loadProfile(event.pubkey);
      decision = this.#route(event);
    }
    switch (decision.type) {
      case "request":
        return this.#request(event, decision.thread);
      case "context":
        return this.#contextMessage(event, decision.thread);
      case "control":
        return this.#controlCommand(event, decision.thread, decision.control);
      case "edit":
        return this.#rewrite(event, decision.target, "replace");
      case "delete":
        return this.#rewrite(event, decision.target, "omit");
      default:
        return;
    }
  }

  async #request(event: NostrEvent, thread: ThreadRef): Promise<void> {
    const { domain, conversation, state } = await this.#conversationFor(
      thread,
      event,
    );
    const content = await this.#render(event);
    const submission = await conversation.submit(
      { type: "input", content, requestId: event.id, whenBusy: "steer" },
      this.#context,
    );
    const created = await conversation.commit(async (tx) => {
      const requests = await tx.doc(RequestsDoc, conversation.id);
      if (requests.items[event.id] !== undefined) return false;
      const replyTaskId = await tx.createTask(
        this.#agent.replyTask,
        { requestId: event.id, author: event.pubkey, content },
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        },
      );
      requests.items[event.id] = {
        author: event.pubkey,
        submissionId: submission.id,
        replyTaskId,
      };
      return true;
    }, this.#context);
    this.#control.addMessages([event.id], domain.key, thread.key);
    if (!created) return; // A replayed event: already acknowledged.
    this.#options.log.info("request admitted", {
      domain: domain.key,
      thread: thread.key,
      eventId: event.id,
    });
    this.#broker.react(event, "👀");
    this.#typingWhile(state, event, submission.wait(this.#context));
  }

  async #contextMessage(event: NostrEvent, thread: ThreadRef): Promise<void> {
    const domainKey = this.#control.domainOfThread(thread.key);
    if (domainKey === undefined) return;
    // The conversation carries the audience its channel had when it started.
    // After a visibility change, new messages must not flow into it; the next
    // request in the thread starts a conversation in the right domain.
    if (domainKey !== this.#directory.audienceOf(thread.channelId)?.domain) {
      return;
    }
    // Already there, from the thread history the conversation started with.
    if (
      this.#control
        .placesOf(event.id)
        .some((place) => place.domain === domainKey)
    ) {
      return;
    }
    const conversation = await (await this.#domain(domainKey)).find(
      thread.key,
      this.#context,
    );
    if (conversation === undefined) return;
    const rendered = await this.#render(event);
    await conversation.submit(
      {
        type: "write",
        entry: {
          kind: BuzzMessageEntry.kind,
          model: [userMessage(rendered, event.created_at)],
          data: {
            eventId: event.id,
            author: event.pubkey,
            kind: event.kind,
            createdAt: event.created_at,
          },
        },
        requestId: event.id,
      },
      this.#context,
    );
    this.#control.addMessages([event.id], domainKey, thread.key);
  }

  /**
   * Apply an edit (`replace`) or deletion (`omit`) to every conversation the
   * message entered, so the model sees what people see. An edit made after
   * the channel changed audience removes the old text instead of carrying the
   * new text into a conversation with the old audience.
   */
  async #rewrite(
    event: NostrEvent,
    target: string,
    action: "replace" | "omit",
  ): Promise<void> {
    for (const place of this.#control.placesOf(target)) {
      const domain = await this.#domain(place.domain);
      const conversation = await domain.find(place.threadKey, this.#context);
      if (conversation === undefined) continue;
      const sameAudience =
        this.#directory.audienceOf(channelOfThread(place.threadKey))?.domain ===
        place.domain;
      const effective =
        action === "replace" && sameAudience ? "replace" : "omit";
      const found = await locateMessage(
        domain,
        conversation,
        target,
        this.#context,
      );
      if (found === undefined) continue;
      if ("queued" in found) {
        if (effective === "replace") {
          // Not in the transcript yet; the retry applies it once it is.
          throw new Error(`message ${target} is not placed yet`);
        }
        const result = await domain.harness.abortSubmission(
          found.queued,
          this.#context,
          conversation.id,
        );
        if (result !== "already_placed") continue;
        // Placed in the meantime: the retry finds its entry.
        throw new Error(`message ${target} was placed while being withdrawn`);
      }
      const edit =
        effective === "omit"
          ? { target: found.entry, action: "omit" as const }
          : {
              target: found.entry,
              action: "replace" as const,
              messages: [
                userMessage(
                  await this.#render({ ...event, id: target }),
                  event.created_at,
                ),
              ],
            };
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: `buzz.${effective === "omit" ? "deletion" : "edit"}`,
            edits: [edit],
          },
          requestId: event.id,
        },
        this.#context,
      );
    }
  }

  /**
   * Carry out `stop` or `status` once, then post its notice. The action and
   * its notice are recorded before the notice goes out, so a failed notice is
   * retried without stopping again, and a replay repeats neither.
   */
  async #controlCommand(
    event: NostrEvent,
    thread: ThreadRef,
    control: Control,
  ): Promise<void> {
    let record = this.#control.control(event.id);
    if (record?.done === true) return;
    if (record === undefined) {
      const notice =
        control === "stop"
          ? await this.#stop(thread)
          : await this.#status(thread);
      this.#control.recordControl(event, thread.channelId, notice);
      record = { notice, done: false };
    }
    await this.#notice(thread, event, record.notice);
    this.#control.finishControl(event.id);
  }

  /** Stop the thread's run and its research jobs; returns the notice. */
  async #stop(thread: ThreadRef): Promise<string> {
    const domainKey = this.#control.domainOfThread(thread.key);
    const domain =
      domainKey === undefined ? undefined : await this.#domain(domainKey);
    const conversation =
      domain === undefined
        ? undefined
        : await domain.find(thread.key, this.#context);
    if (domain === undefined || conversation === undefined) {
      return "There is nothing running here.";
    }
    const jobs = await domain.harness.snapshot(
      ResearchJobsDoc,
      conversation.id,
      this.#context,
    );
    for (const job of Object.values(jobs?.jobs ?? {})) {
      if (job.status !== "running") continue;
      const child = await domain.harness.conversation(
        job.childId as ConversationId,
        this.#context,
      );
      await child?.abort(this.#context);
    }
    await conversation.abort(this.#context);
    return "Stopped.";
  }

  /** What the thread's conversation is doing; returns the notice. */
  async #status(thread: ThreadRef): Promise<string> {
    const domainKey = this.#control.domainOfThread(thread.key);
    const domain =
      domainKey === undefined ? undefined : await this.#domain(domainKey);
    const conversation =
      domain === undefined
        ? undefined
        : await domain.find(thread.key, this.#context);
    if (domain === undefined || conversation === undefined) {
      return "I haven't been asked anything in this thread yet.";
    }
    const harness = domain.harness;
    const live = await harness.snapshot(
      LiveDoc,
      conversation.id,
      this.#context,
    );
    const inbox = await harness.snapshot(
      InboxDoc,
      conversation.id,
      this.#context,
    );
    const jobs = Object.entries(
      (await harness.snapshot(ResearchJobsDoc, conversation.id, this.#context))
        ?.jobs ?? {},
    ).sort(([, a], [, b]) => b.startedAt - a.startedAt);
    const usage = await harness.snapshot(
      UsageDoc,
      conversation.id,
      this.#context,
    );
    const cost = Object.values(usage?.models ?? {}).reduce(
      (sum, item) => sum + (item.cost?.total ?? 0),
      0,
    );
    const lines = [
      live?.run === undefined
        ? "Idle in this thread."
        : "Working on a request in this thread.",
      `${inbox?.items.length ?? 0} queued.`,
      ...jobs
        .slice(0, STATUS_JOBS)
        .map(([id, job]) => `Research ${id}: ${job.status} — ${job.question}`),
      ...(jobs.length > STATUS_JOBS
        ? [`…and ${jobs.length - STATUS_JOBS} earlier research jobs.`]
        : []),
      `Model spend here so far: $${cost.toFixed(4)}.`,
    ];
    return lines.join("\n");
  }

  // ─── Conversations and domains ────────────────────────────────────────────

  async #conversationFor(
    thread: ThreadRef,
    trigger: NostrEvent,
  ): Promise<{
    domain: Domain;
    conversation: Conversation;
    state: ThreadState;
  }> {
    const channel = this.#directory.get(thread.channelId);
    const audience = this.#directory.audienceOf(thread.channelId);
    if (channel === undefined || audience === undefined)
      throw new Error(`unknown channel ${thread.channelId}`);
    const domain = await this.#domain(audience.domain);
    const state: ThreadState = {
      domain: audience.domain,
      channelId: channel.id,
      channelName: channel.name,
      root: thread.root,
      dm: thread.dm,
    };
    const conversation = await domain.conversationFor(
      thread.key,
      state,
      { model: this.#options.model },
      () => this.#history(state, thread, trigger),
      this.#context,
    );
    this.#control.addThread(thread.key, audience.domain);
    return { domain, conversation, state };
  }

  /** The thread so far, for a new conversation: the messages before the one that addressed Keeper. */
  async #history(
    state: ThreadState,
    thread: ThreadRef,
    trigger: NostrEvent,
  ): Promise<HistoryEntry[]> {
    const events = await this.#broker.channelRead(state.domain, {
      channelId: state.channelId,
      ...(state.root === null ? {} : { rootEventId: state.root }),
      limit: state.root === null ? 30 : 200,
    });
    const entries: HistoryEntry[] = [];
    for (const event of events) {
      if (event.id === trigger.id || event.created_at > trigger.created_at)
        continue;
      entries.push({
        model: [userMessage(await this.#render(event), event.created_at)],
        data: {
          eventId: event.id,
          author: event.pubkey,
          kind: event.kind,
          createdAt: event.created_at,
        },
      });
    }
    this.#control.addMessages(
      entries.map((entry) => entry.data.eventId),
      state.domain,
      thread.key,
    );
    return entries;
  }

  #domain(key: string): Promise<Domain> {
    this.#lastUsed.set(key, Date.now());
    let domain = this.#domains.get(key);
    if (domain === undefined) {
      const closing = this.#closing.get(key) ?? Promise.resolve();
      domain = closing.then(() =>
        Domain.open(
          {
            key,
            dataDir: this.#options.dataDir,
            models: this.#options.models,
            registry: this.#agent.registry,
            settings: {
              extensions: this.#agent.threadExtensions(key),
              ...this.#options.settings,
            },
            log: this.#options.log,
          },
          this.#context,
        ),
      );
      this.#domains.set(key, domain);
      domain.catch(() => this.#domains.delete(key));
    }
    return domain;
  }

  /**
   * Reopen every domain with stored state, one at a time, so unfinished runs,
   * replies and research resume; domains with nothing live close again.
   */
  async #resumeDomains(): Promise<void> {
    const directory = path.join(this.#options.dataDir, "domains");
    const keys = await readdir(directory).catch(() => [] as string[]);
    for (const key of keys) {
      await this.#domain(key);
      await this.#closeIfIdle(key, 0);
    }
  }

  /** Close domains that have had nothing live for a while; they reopen on demand. */
  async #sweepDomains(): Promise<void> {
    for (const key of [...this.#domains.keys()]) {
      if (this.#stopped) return;
      await this.#closeIfIdle(key, DOMAIN_IDLE_MS).catch((error: unknown) =>
        this.#options.log.warn("could not close an idle domain", {
          domain: key,
          error: String(error),
        }),
      );
    }
  }

  async #closeIfIdle(key: string, idleMs: number): Promise<void> {
    const opening = this.#domains.get(key);
    if (opening === undefined) return;
    const idle = () => Date.now() - (this.#lastUsed.get(key) ?? 0) >= idleMs;
    if (!idle()) return;
    const domain = await opening;
    const inspection = await domain.harness.inspect(this.#context);
    if (inspection.tasks.length > 0 || inspection.submissions.length > 0) {
      return;
    }
    // Someone may have picked the domain up while it was being inspected.
    if (this.#domains.get(key) !== opening || !idle()) return;
    this.#domains.delete(key);
    const closing = domain.close(this.#context).finally(() => {
      if (this.#closing.get(key) === closing) this.#closing.delete(key);
    });
    this.#closing.set(key, closing);
    await closing;
  }

  // ─── Output helpers ───────────────────────────────────────────────────────

  async #render(event: NostrEvent): Promise<string> {
    const self = event.pubkey === this.pubkey;
    return renderMessage({
      eventId: event.id,
      authorName: self
        ? `${this.#options.name} (you)`
        : await this.#broker.displayName(event.pubkey),
      authorPubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content,
    });
  }

  /**
   * A reply outside the durable reply path, for control phrases and apologies.
   * Throws when the relay does not take it, so the caller's retry applies.
   */
  async #notice(
    thread: ThreadRef,
    event: NostrEvent,
    text: string,
  ): Promise<void> {
    const audience = this.#directory.audienceOf(thread.channelId);
    if (audience === undefined) return;
    const signed = this.#broker.signForChannel(
      audience.domain,
      thread.channelId,
      {
        kind: Kind.StreamMessage,
        created_at: nowSeconds(),
        tags: [
          ["h", thread.channelId],
          ...(thread.root === null ? [] : replyTags(thread.root, event.id)),
        ],
        content: text,
      },
    );
    const result = await this.#broker.publish(signed);
    if (!result.ok) throw new Error(`notice not published: ${result.message}`);
  }

  #typingWhile(
    state: ThreadState,
    trigger: NostrEvent,
    settled: Promise<unknown>,
  ): void {
    let done = false;
    const finish = () => {
      done = true;
    };
    settled.then(finish, finish);
    const started = Date.now();
    const tick = () => {
      if (done || this.#stopped || Date.now() - started > 600_000) return;
      this.#broker.typing(
        state.channelId,
        state.root,
        state.root === null ? null : trigger.id,
      );
      setTimeout(tick, this.#options.typingIntervalMs ?? 3_000).unref();
    };
    tick();
  }
}

function userMessage(text: string, createdAt: number): UserMessage {
  return { role: "user", content: text, timestamp: createdAt * 1000 };
}

/** The channel of a thread key: `dm:<channel>` or `<channel>:<root>`. */
function channelOfThread(threadKey: string): string {
  return threadKey.startsWith("dm:")
    ? threadKey.slice(3)
    : (threadKey.split(":")[0] ?? threadKey);
}

/**
 * Where a Buzz message sits in a conversation: its entry, or its submission
 * while that is still queued. Requests and later messages are submissions
 * keyed by event id; the thread history a conversation started with is in
 * `HistoryDoc`.
 */
async function locateMessage(
  domain: Domain,
  conversation: Conversation,
  eventId: string,
  context: Context,
): Promise<{ entry: EntryId } | { queued: SubmissionId } | undefined> {
  const record = await conversation.commit(
    (tx) => tx.submissionByRequest(conversation.id, eventId),
    context,
  );
  if (record !== undefined) {
    if (record.status === "queued") return { queued: record.id };
    return record.entry === undefined ? undefined : { entry: record.entry };
  }
  const history = await domain.harness.snapshot(
    HistoryDoc,
    conversation.id,
    context,
  );
  const entry = history?.entries[eventId];
  return entry === undefined ? undefined : { entry: entry as EntryId };
}

/** Insertion-ordered set that forgets its oldest members past `limit`. */
class BoundedSet {
  readonly #items = new Set<string>();
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  has(value: string): boolean {
    return this.#items.has(value);
  }
  delete(value: string): void {
    this.#items.delete(value);
  }
  add(value: string): void {
    this.#items.add(value);
    if (this.#items.size > this.#limit) {
      const oldest = this.#items.values().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
  }
}

class BoundedMap<K, V> {
  readonly #items = new Map<K, V>();
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  get(key: K): V | undefined {
    return this.#items.get(key);
  }
  set(key: K, value: V): void {
    this.#items.delete(key);
    this.#items.set(key, value);
    if (this.#items.size > this.#limit) {
      const oldest = this.#items.keys().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
  }
}
