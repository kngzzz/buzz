/** Nostr event shapes and the Buzz-specific tag conventions Keeper depends on. */

export type NostrEvent = {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
};

/** An event before Keeper's broker signs it. */
export type EventTemplate = {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
};

/** NIP-01 filter. Buzz rejects filters without `kinds` outside a channel (the p-gate). */
export type Filter = {
  readonly ids?: readonly string[];
  readonly authors?: readonly string[];
  readonly kinds: readonly number[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly "#h"?: readonly string[];
  readonly "#p"?: readonly string[];
  readonly "#e"?: readonly string[];
  readonly "#d"?: readonly string[];
};

/** Kinds Keeper reads or writes; the source of truth is `crates/buzz-core/src/kind.rs`. */
export const Kind = {
  Profile: 0,
  Deletion: 5,
  Reaction: 7,
  StreamMessage: 9,
  PutUser: 9000,
  ModerationRemove: 9005,
  AgentProfile: 10100,
  PresenceUpdate: 20001,
  TypingIndicator: 20002,
  Auth: 22242,
  ChannelMetadata: 39000,
  ChannelMembers: 39002,
  StreamMessageV2: 40002,
  StreamMessageEdit: 40003,
  SystemMessage: 40099,
  MemberAdded: 44100,
  MemberRemoved: 44101,
  ForumPost: 45001,
  ForumComment: 45003,
} as const;

/** Kinds that carry something a person said. */
export const MESSAGE_KINDS: readonly number[] = [
  Kind.StreamMessage,
  Kind.StreamMessageV2,
  Kind.ForumPost,
  Kind.ForumComment,
];

/** Everything Keeper subscribes to inside a channel (`#h`). */
export const CHANNEL_KINDS: readonly number[] = [
  ...MESSAGE_KINDS,
  Kind.StreamMessageEdit,
  Kind.Deletion,
  Kind.ModerationRemove,
  Kind.ChannelMembers,
];

export function tagValue(
  event: Pick<NostrEvent, "tags">,
  name: string,
): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function tagValues(
  event: Pick<NostrEvent, "tags">,
  name: string,
): string[] {
  return event.tags.flatMap((tag) =>
    tag[0] === name && tag[1] !== undefined ? [tag[1]] : [],
  );
}

/** The channel (`h` tag) an event belongs to. */
export function channelOf(event: Pick<NostrEvent, "tags">): string | undefined {
  return tagValue(event, "h");
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * NIP-10 thread position, resolved exactly as the relay does
 * (`crates/buzz-core/src/nip10.rs`): `root` + `reply` gives (root, parent),
 * `reply` alone is a direct reply to the root, anything else is top-level.
 */
export function threadPosition(
  event: Pick<NostrEvent, "tags">,
): { readonly root: string; readonly parent: string } | undefined {
  let root: string | undefined;
  let reply: string | undefined;
  for (const tag of event.tags) {
    if (tag[0] !== "e" || tag[1] === undefined || !HEX64.test(tag[1])) {
      continue;
    }
    if (tag[3] === "root") root = tag[1];
    else if (tag[3] === "reply") reply = tag[1];
  }
  if (reply === undefined) return undefined;
  return { root: root ?? reply, parent: reply };
}

/** NIP-10 tags for a reply: a direct reply when the parent is the root. */
export function replyTags(root: string, parent: string): string[][] {
  return root === parent
    ? [["e", root, "", "reply"]]
    : [
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ];
}

/** Whether `event` p-tags `pubkey`, which is how Buzz clients address a mention. */
export function mentions(
  event: Pick<NostrEvent, "tags">,
  pubkey: string,
): boolean {
  return tagValues(event, "p").some(
    (value) => value.toLowerCase() === pubkey.toLowerCase(),
  );
}

/** Unix seconds, the unit of `created_at`. */
export function nowSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}
