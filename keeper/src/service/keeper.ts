import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, UserMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  type ModelRef,
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
  RequestsDoc,
  type ThreadState,
} from "../runtime/docs.ts";
import { Domain, type HistoryEntry } from "../runtime/domain.ts";
import { renderMessage } from "../runtime/render.ts";
import { ControlStore } from "./control.ts";
import { type Route, route, type ThreadRef, threadOf } from "./router.ts";

/** Attempts at handling one event before Keeper gives up and tells the thread. */
const MAX_ATTEMPTS = 6;

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
  readonly #seen = new BoundedSet(20_000);
  /** Recent message id → thread key, for edits and deletions (deleted events can no longer be queried). */
  readonly #messageThreads = new BoundedMap<string, string>(50_000);
  readonly #queues = new Map<string, Promise<void>>();
  /** Events with a retry record, so success clears it. */
  readonly #retrying = new Set<string>();
  readonly #startedAt = nowSeconds();
  #channelSubscriptions: (() => void)[] = [];
  #subscriptionGeneration = 0;
  #retryTimer: ReturnType<typeof setInterval> | undefined;
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
    await this.#openExistingDomains();
    this.#relay.subscribe(
      "keeper-membership",
      () => [
        {
          kinds: [Kind.MemberAdded, Kind.MemberRemoved],
          "#p": [this.pubkey],
          since: this.#startedAt - 60,
        },
      ],
      { onEvent: (event) => this.#enqueue(event) },
    );
    this.#subscribeChannels();
    this.#retryTimer = setInterval(
      () => this.#pumpRetries(),
      Math.min(1_000, this.#options.retryBaseMs ?? 2_000),
    );
    this.#retryTimer.unref();
    log.info("keeper started", {
      pubkey: this.pubkey,
      channels: this.#directory.all().length,
      domains: this.#domains.size,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#retryTimer);
    for (const unsubscribe of this.#channelSubscriptions) unsubscribe();
    await Promise.allSettled([...this.#queues.values()]);
    await this.#relay.stop();
    for (const domain of this.#domains.values()) {
      await (await domain).close(this.#context).catch(() => {});
    }
    this.#domains.clear();
    this.#control.close();
  }

  // ─── Channels and membership ──────────────────────────────────────────────

  async #discoverChannels(): Promise<void> {
    const memberLists = await this.#relay.query([
      { kinds: [Kind.ChannelMembers], "#p": [this.pubkey] },
    ]);
    const ids: string[] = [];
    for (const event of memberLists) {
      const channel = this.#directory.apply(event);
      if (channel !== undefined) ids.push(channel.id);
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
      for (const metadata of events) this.#directory.apply(metadata);
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
      const since = () =>
        Math.min(...batch.map((id) => this.#control.since(id, fallback)));
      this.#channelSubscriptions.push(
        this.#relay.subscribe(
          `keeper-channels-${generation}-${start / 100}`,
          () => [{ kinds: CHANNEL_KINDS, "#h": batch, since: since() }],
          {
            onEvent: (event) => this.#enqueue(event),
            onClosed: (reason) =>
              this.#options.log.warn("channel subscription closed", { reason }),
          },
        ),
      );
    }
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * Take one relay event. Events of one thread are handled in order and
   * different threads concurrently. A failed event gets a durable retry record;
   * after the last attempt Keeper says so in the thread, so nobody waits on a
   * request that will never be answered.
   */
  #enqueue(event: NostrEvent): void {
    if (this.#stopped || this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (event.kind === Kind.ChannelMembers) {
      this.#directory.apply(event);
      return;
    }
    const key = this.#queueKeyOf(event);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handle(event))
      .then(
        () => this.#settled(event, undefined),
        (error: unknown) => this.#settled(event, error),
      );
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
    return (
      (target === undefined ? undefined : this.#messageThreads.get(target)) ??
      `channel:${channelId ?? event.id}`
    );
  }

  #settled(event: NostrEvent, error: unknown): void {
    const { log } = this.#options;
    try {
      if (error === undefined) {
        const channelId = channelOf(event);
        if (channelId !== undefined)
          this.#control.advance(channelId, event.created_at);
        if (this.#retrying.delete(event.id)) this.#control.clearRetry(event.id);
        return;
      }
      const attempts = this.#control.retryAttempts(event.id) + 1;
      if (attempts < MAX_ATTEMPTS) {
        const delayMs = Math.min(
          60_000,
          (this.#options.retryBaseMs ?? 2_000) * 2 ** (attempts - 1),
        );
        this.#control.scheduleRetry(event, attempts, Date.now() + delayMs);
        this.#retrying.add(event.id);
        this.#seen.delete(event.id);
        log.warn("event handling failed; will retry", {
          eventId: event.id,
          attempts,
          error: String(error),
        });
        return;
      }
      // Terminal: stays in #seen, so only a restart's replay can try it again.
      this.#retrying.delete(event.id);
      this.#control.clearRetry(event.id);
      log.error("event handling failed; giving up", {
        eventId: event.id,
        attempts,
        error: String(error),
      });
      void this.#apologize(event);
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
      for (const event of this.#control.dueRetries(Date.now(), 100)) {
        this.#retrying.add(event.id);
        this.#enqueue(event);
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
    try {
      await this.#notice(
        decision.thread,
        event,
        "Sorry, I couldn't take this request. Please ask me again in a moment.",
      );
    } catch (error) {
      this.#options.log.error("could not post apology", {
        eventId: event.id,
        error: String(error),
      });
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
      // Whether the author is an agent comes from their profile; load it before
      // letting them wake Keeper, then decide again. The thread stays the same.
      await this.#broker.displayName(event.pubkey);
      decision = this.#route(event);
    }
    switch (decision.type) {
      case "request":
        return this.#request(event, decision.thread);
      case "context":
        return this.#contextMessage(event, decision.thread);
      case "control": {
        // A replay must not stop or report twice. Recorded after success, so a
        // failure is retried; only a crash in between can repeat a notice.
        if (this.#control.handled(event.id)) return;
        if (decision.control === "stop")
          await this.#stop(event, decision.thread);
        else await this.#status(event, decision.thread);
        this.#control.markHandled(event, decision.thread.channelId);
        return;
      }
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
    this.#messageThreads.set(event.id, thread.key);
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
    this.#messageThreads.set(event.id, thread.key);
  }

  /** Apply an edit (`replace`) or deletion (`omit`) to the message's entry, so the model sees what people see. */
  async #rewrite(
    event: NostrEvent,
    target: string,
    action: "replace" | "omit",
  ): Promise<void> {
    const threadKey = this.#messageThreads.get(target);
    const domainKey =
      threadKey === undefined
        ? undefined
        : this.#control.domainOfThread(threadKey);
    if (threadKey === undefined || domainKey === undefined) return;
    const conversation = await (await this.#domain(domainKey)).find(
      threadKey,
      this.#context,
    );
    if (conversation === undefined) return;
    const entryId = await findMessageEntry(conversation, target, this.#context);
    if (entryId === undefined) return;
    const edit =
      action === "omit"
        ? { target: entryId, action: "omit" as const }
        : {
            target: entryId,
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
          kind: `buzz.${action === "omit" ? "deletion" : "edit"}`,
          edits: [edit],
        },
        requestId: event.id,
      },
      this.#context,
    );
  }

  async #stop(event: NostrEvent, thread: ThreadRef): Promise<void> {
    const domainKey = this.#control.domainOfThread(thread.key);
    const domain =
      domainKey === undefined ? undefined : await this.#domain(domainKey);
    const conversation =
      domain === undefined
        ? undefined
        : await domain.find(thread.key, this.#context);
    if (domain === undefined || conversation === undefined) {
      await this.#notice(thread, event, "There is nothing running here.");
      return;
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
    await this.#notice(thread, event, "Stopped.");
  }

  async #status(event: NostrEvent, thread: ThreadRef): Promise<void> {
    const domainKey = this.#control.domainOfThread(thread.key);
    const domain =
      domainKey === undefined ? undefined : await this.#domain(domainKey);
    const conversation =
      domain === undefined
        ? undefined
        : await domain.find(thread.key, this.#context);
    if (domain === undefined || conversation === undefined) {
      await this.#notice(
        thread,
        event,
        "I haven't been asked anything in this thread yet.",
      );
      return;
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
    );
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
      ...jobs.map(
        ([id, job]) => `Research ${id}: ${job.status} — ${job.question}`,
      ),
      `Model spend here so far: $${cost.toFixed(4)}.`,
    ];
    await this.#notice(thread, event, lines.join("\n"));
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
      () => this.#history(state, trigger),
      this.#context,
    );
    this.#control.addThread(thread.key, audience.domain);
    return { domain, conversation, state };
  }

  /** The thread so far, for a new conversation: the messages before the one that addressed Keeper. */
  async #history(
    state: ThreadState,
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
      this.#messageThreads.set(event.id, threadKeyOf(state));
    }
    return entries;
  }

  #domain(key: string): Promise<Domain> {
    let domain = this.#domains.get(key);
    if (domain === undefined) {
      domain = Domain.open(
        {
          key,
          dataDir: this.#options.dataDir,
          models: this.#options.models,
          registry: this.#agent.registry,
          settings: {
            extensions: this.#agent.threadExtensions,
            ...this.#options.settings,
          },
          log: this.#options.log,
        },
        this.#context,
      );
      this.#domains.set(key, domain);
      domain.catch(() => this.#domains.delete(key));
    }
    return domain;
  }

  /** Reopen every domain with stored state, so unfinished runs, replies and research resume. */
  async #openExistingDomains(): Promise<void> {
    const directory = path.join(this.#options.dataDir, "domains");
    const keys = await readdir(directory).catch(() => [] as string[]);
    await Promise.all(keys.map((key) => this.#domain(key)));
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

function threadKeyOf(state: ThreadState): string {
  return state.dm
    ? `dm:${state.channelId}`
    : `${state.channelId}:${state.root}`;
}

/** The entry that carries a Buzz message, searched newest first through recent history. */
async function findMessageEntry(
  conversation: Conversation,
  eventId: string,
  context: Context,
): Promise<EntryRecord["id"] | undefined> {
  let cursor: Parameters<Conversation["entries"]>[2];
  for (let page = 0; page < 10; page++) {
    const result = await conversation.entries({}, 100, cursor, context);
    for (const entry of result.items) {
      if (BuzzMessageEntry.is(entry) && entry.data.eventId === eventId)
        return entry.id;
      const message = entry.model?.[0];
      if (
        entry.kind === "pi.user" &&
        message?.role === "user" &&
        typeof message.content === "string"
      ) {
        if (message.content.includes(`id="${eventId}"`)) return entry.id;
      }
    }
    if (result.next === undefined) return undefined;
    cursor = result.next;
  }
  return undefined;
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
