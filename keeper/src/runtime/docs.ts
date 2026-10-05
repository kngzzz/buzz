import {
  defineDoc,
  defineDocFamily,
  defineEntry,
} from "@earendil-works/pi-durable";

/**
 * Durable state Keeper keeps next to pi-durable's own documents. Values must
 * be strict JSON, so absent values are `null`, never `undefined`.
 */

/** The Buzz place a conversation answers in; written in the creating commit. */
export type ThreadState = {
  /** Domain key, which fixes the conversation's audience for its lifetime. */
  domain: string;
  channelId: string;
  channelName: string;
  /** Thread root event; `null` for a DM conversation. */
  root: string | null;
  dm: boolean;
};

export const ThreadDoc = defineDoc<ThreadState>({
  kind: "keeper.thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    domain: "",
    channelId: "",
    channelName: "",
    root: null,
    dm: false,
  }),
});

/** Session-wide map from a thread key to its conversation. */
export const BindingDoc = defineDocFamily<{ conversationId: number }, null>({
  kind: "keeper.binding",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversationId: 0 }),
});

/**
 * Requests a conversation owes an answer to, keyed by request id (the Buzz
 * event id). Each has a durable reply task; recording it here in the same
 * commit that creates the task keeps creation idempotent.
 */
export const RequestsDoc = defineDoc<{
  items: Record<
    string,
    { author: string; submissionId: number; replyTaskId: number }
  >;
}>({
  kind: "keeper.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
});

/**
 * Which reply task posts each answer. Steered inputs settle with the same
 * answer entry, so the first task to claim an answer posts it and the others
 * post nothing.
 */
export const AnswersDoc = defineDoc<{ claims: Record<string, number> }>({
  kind: "keeper.answers",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ claims: {} }),
});

/**
 * Entries of the thread history a conversation was created with, by Buzz event
 * id. Those entries are appended directly rather than submitted, so this is
 * how a later edit or deletion finds them.
 */
export const HistoryDoc = defineDoc<{ entries: Record<string, number> }>({
  kind: "keeper.history",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ entries: {} }),
});

/** Data of a `buzz.message` entry: a Buzz event a conversation has seen. */
export type BuzzMessageData = {
  eventId: string;
  author: string;
  kind: number;
  createdAt: number;
};

export const BuzzMessageEntry = defineEntry<BuzzMessageData>("buzz.message");

/** Tag on a research report Keeper posts, so the thread takes it in as context. */
export const REPORT_TAG = "keeper-report";
