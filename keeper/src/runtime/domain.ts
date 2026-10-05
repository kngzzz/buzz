import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models, UserMessage } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type Conversation,
  type ConversationId,
  Harness,
  type HarnessSettings,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Logger } from "../log.ts";
import {
  BindingDoc,
  type BuzzMessageData,
  BuzzMessageEntry,
  HistoryDoc,
  ThreadDoc,
  type ThreadState,
} from "./docs.ts";

/** A Buzz message from before a conversation existed, as it enters the conversation. */
export type HistoryEntry = {
  readonly model: UserMessage[];
  readonly data: BuzzMessageData;
};

export type DomainOptions = {
  /** `public`, `channel-<uuid>` or `dm-<uuid>`; one audience each. */
  readonly key: string;
  readonly dataDir: string;
  readonly models: Models;
  readonly registry: Registry;
  readonly settings: HarnessSettings;
  readonly log: Logger;
};

/**
 * One audience's durable runtime: a pi-durable Harness over its own SQLite
 * file. No conversation, document or task here can see another domain's state,
 * which makes the information-flow draft's "instance per audience" structural.
 */
export class Domain {
  readonly key: string;
  readonly harness: Harness;
  readonly #creating = new Map<string, Promise<Conversation>>();

  private constructor(key: string, harness: Harness) {
    this.key = key;
    this.harness = harness;
  }

  static async open(options: DomainOptions, context: Context): Promise<Domain> {
    const directory = path.join(options.dataDir, "domains", options.key);
    await mkdir(directory, { recursive: true });
    const storage = await openNodeSqliteStorage(
      path.join(directory, "session.sqlite"),
    );
    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry: options.registry,
        settings: options.settings,
        onReport: (error) =>
          options.log.warn("domain report", {
            domain: options.key,
            error: String(error),
          }),
      },
      context,
    );
    harness.resume();
    return new Domain(options.key, harness);
  }

  /** The conversation bound to `threadKey`, if any. */
  async find(
    threadKey: string,
    context: Context,
  ): Promise<Conversation | undefined> {
    const binding = await this.harness.snapshot(BindingDoc, threadKey, context);
    if (binding === undefined || binding.conversationId === 0) return undefined;
    return this.harness.conversation(
      binding.conversationId as ConversationId,
      context,
    );
  }

  /**
   * The conversation bound to `threadKey`, created on first use with the thread
   * so far (`history`, read before anything is written). The conversation, its
   * binding, its thread state and its history are one commit, so a failed read
   * or a crash never leaves a conversation without its binding or its history.
   * Concurrent callers share one creation.
   */
  async conversationFor(
    threadKey: string,
    thread: ThreadState,
    agent: AgentChange,
    history: () => Promise<readonly HistoryEntry[]>,
    context: Context,
  ): Promise<Conversation> {
    const existing = await this.find(threadKey, context);
    if (existing !== undefined) return existing;
    const pending = this.#creating.get(threadKey);
    if (pending !== undefined) return pending;
    const creation = (async () => {
      const entries = await history();
      const raced = await this.find(threadKey, context);
      if (raced !== undefined) return raced;
      return this.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent,
          init: async (tx, id) => {
            Object.assign(await tx.doc(ThreadDoc, id), thread);
            (await tx.doc(BindingDoc, threadKey, null)).conversationId = id;
            const history = await tx.doc(HistoryDoc, id);
            for (const entry of entries) {
              const record = await tx.appendEntry(BuzzMessageEntry, id, {
                model: [...entry.model],
                data: entry.data,
              });
              history.entries[entry.data.eventId] = record.id;
            }
          },
        },
        context,
      );
    })();
    this.#creating.set(threadKey, creation);
    try {
      return await creation;
    } finally {
      this.#creating.delete(threadKey);
    }
  }

  close(context: Context): Promise<void> {
    return this.harness.close(context);
  }
}
