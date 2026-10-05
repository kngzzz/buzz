import type { ChannelInfo } from "../broker/directory.ts";
import { REPORT_TAG } from "../runtime/docs.ts";
import {
  channelOf,
  Kind,
  MESSAGE_KINDS,
  mentions,
  type NostrEvent,
  tagValue,
  threadPosition,
} from "../nostr/event.ts";

/** Where a conversation lives in Buzz. */
export type ThreadRef = {
  readonly key: string;
  readonly channelId: string;
  /** Thread root; `null` for a DM conversation. */
  readonly root: string | null;
  readonly dm: boolean;
};

export type Control = "stop" | "status";

export type Route =
  | { readonly type: "ignore"; readonly reason: string }
  | { readonly type: "request"; readonly thread: ThreadRef }
  | {
      readonly type: "control";
      readonly thread: ThreadRef;
      readonly control: Control;
    }
  | { readonly type: "context"; readonly thread: ThreadRef }
  | {
      readonly type: "edit";
      readonly channelId: string;
      readonly target: string;
    }
  | {
      readonly type: "delete";
      readonly channelId: string | undefined;
      readonly target: string;
    }
  | { readonly type: "members"; readonly channelId: string };

export type RouteInput = {
  readonly event: NostrEvent;
  readonly self: string;
  readonly channel: ChannelInfo | undefined;
  /** Whether a conversation already exists for this event's thread. */
  readonly hasConversation: (threadKey: string) => boolean;
  /** Agents allowed to wake Keeper; every other agent is ignored as a trigger. */
  readonly isAgent: (pubkey: string) => boolean;
  readonly allowedAgents: ReadonlySet<string>;
};

/** The conversation key of a message: one per DM, one per channel thread. */
export function threadOf(event: NostrEvent, channel: ChannelInfo): ThreadRef {
  if (channel.type === "dm") {
    return {
      key: `dm:${channel.id}`,
      channelId: channel.id,
      root: null,
      dm: true,
    };
  }
  const root = threadPosition(event)?.root ?? event.id;
  return {
    key: `${channel.id}:${root}`,
    channelId: channel.id,
    root,
    dm: false,
  };
}

/** Strip a leading mention such as `@Keeper` and return the remaining words. */
export function controlOf(
  content: string,
  names: readonly string[],
): Control | undefined {
  let text = content.trim();
  for (const name of names) {
    const mention = new RegExp(`^@${escapeRegExp(name)}\\b`, "i");
    text = text.replace(mention, "").trim();
  }
  const word = text.replace(/[.!]+$/, "").toLowerCase();
  if (word === "stop" || word === "/stop" || word === "cancel") return "stop";
  if (word === "status" || word === "/status") return "status";
  return undefined;
}

/**
 * Decide what one relay event means for Keeper. Pure, so it can be tested over
 * its whole input space; side effects belong to the service.
 */
export function route(input: RouteInput, names: readonly string[] = []): Route {
  const { event, self, channel } = input;
  if (event.pubkey === self) {
    // A report a background research job posted is new to the thread's conversation.
    const isReport = event.tags.some((tag) => tag[0] === REPORT_TAG);
    if (
      isReport &&
      channel !== undefined &&
      MESSAGE_KINDS.includes(event.kind)
    ) {
      const thread = threadOf(event, channel);
      if (input.hasConversation(thread.key)) return { type: "context", thread };
    }
    return { type: "ignore", reason: "own event" };
  }

  if (event.kind === Kind.ChannelMembers) {
    const channelId = tagValue(event, "d");
    return channelId === undefined
      ? { type: "ignore", reason: "member list without channel" }
      : { type: "members", channelId };
  }

  if (event.kind === Kind.Deletion || event.kind === Kind.ModerationRemove) {
    const target = tagValue(event, "e");
    return target === undefined
      ? { type: "ignore", reason: "deletion without target" }
      : { type: "delete", channelId: channelOf(event), target };
  }

  if (channel === undefined)
    return { type: "ignore", reason: "unknown channel" };

  if (event.kind === Kind.StreamMessageEdit) {
    const target = tagValue(event, "e");
    return target === undefined
      ? { type: "ignore", reason: "edit without target" }
      : { type: "edit", channelId: channel.id, target };
  }

  if (!MESSAGE_KINDS.includes(event.kind))
    return { type: "ignore", reason: "not a message" };

  const thread = threadOf(event, channel);
  // A one-to-one DM is always addressed to Keeper; a group DM needs a mention, like a channel.
  const directMessage = channel.type === "dm" && channel.members.size <= 2;
  const addressed = directMessage || mentions(event, self);
  const triggerable =
    !input.isAgent(event.pubkey) || input.allowedAgents.has(event.pubkey);

  if (addressed && triggerable) {
    const control = controlOf(event.content, names);
    return control === undefined
      ? { type: "request", thread }
      : { type: "control", thread, control };
  }
  if (input.hasConversation(thread.key)) return { type: "context", thread };
  return {
    type: "ignore",
    reason: addressed ? "agent not allowed to trigger" : "not addressed",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
