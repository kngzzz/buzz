import { createHash } from "node:crypto";
import { EVERYONE, only, type ReaderSet } from "../ifc/labels.ts";
import { Kind, type NostrEvent, tagValue, tagValues } from "../nostr/event.ts";

export type ChannelType = "stream" | "forum" | "dm" | "workflow" | "unknown";

export type ChannelInfo = {
  readonly id: string;
  readonly name: string;
  readonly type: ChannelType;
  readonly visibility: "open" | "private";
  readonly archived: boolean;
  readonly members: ReadonlySet<string>;
};

/** Who may see what happens in a domain, and the membership version it was computed from. */
export type Audience = {
  readonly domain: string;
  readonly readers: ReaderSet;
  /** Changes whenever a private audience's membership changes. */
  readonly epoch: string;
};

/**
 * Keeper's view of the channels it can see, built from relay-signed metadata
 * (kind 39000) and member lists (kind 39002). Reader sets come from these
 * relay facts, never from anything a model says.
 */
export class Directory {
  readonly #channels = new Map<string, ChannelInfo>();
  /** Newest applied event per kind and channel; replays and reconnects deliver older ones too. */
  readonly #versions = new Map<
    string,
    { readonly createdAt: number; readonly id: string }
  >();

  get(channelId: string): ChannelInfo | undefined {
    return this.#channels.get(channelId);
  }

  all(): ChannelInfo[] {
    return [...this.#channels.values()];
  }

  delete(channelId: string): void {
    this.#channels.delete(channelId);
    this.#versions.delete(`${Kind.ChannelMetadata}:${channelId}`);
    this.#versions.delete(`${Kind.ChannelMembers}:${channelId}`);
  }

  /**
   * Apply a kind 39000 or 39002 event; returns the channel it changed, or
   * `undefined` for an event older than the one already applied. Newest wins,
   * and the lowest id breaks a tie, as for any NIP-01 replaceable event.
   */
  apply(event: NostrEvent): ChannelInfo | undefined {
    const id = tagValue(event, "d");
    if (id === undefined) return undefined;
    if (
      event.kind !== Kind.ChannelMetadata &&
      event.kind !== Kind.ChannelMembers
    )
      return undefined;
    const key = `${event.kind}:${id}`;
    const applied = this.#versions.get(key);
    if (
      applied !== undefined &&
      (event.created_at < applied.createdAt ||
        (event.created_at === applied.createdAt && event.id >= applied.id))
    ) {
      return undefined;
    }
    this.#versions.set(key, { createdAt: event.created_at, id: event.id });
    const current = this.#channels.get(id) ?? {
      id,
      name: id,
      type: "unknown" as const,
      visibility: "private" as const,
      archived: false,
      members: new Set<string>(),
    };
    const next: ChannelInfo =
      event.kind === Kind.ChannelMetadata
        ? { ...current, ...parseMetadata(event) }
        : {
            ...current,
            members: new Set(tagValues(event, "p").map((p) => p.toLowerCase())),
          };
    this.#channels.set(id, next);
    return next;
  }

  /** Readers of a channel's content, as the relay enforces them. */
  readers(channelId: string): ReaderSet | undefined {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return undefined;
    return channel.visibility === "open" ? EVERYONE : only(channel.members);
  }

  /** The domain a channel's conversations run in. */
  audienceOf(channelId: string): Audience | undefined {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return undefined;
    if (channel.visibility === "open") {
      return { domain: "public", readers: EVERYONE, epoch: "public" };
    }
    const prefix = channel.type === "dm" ? "dm" : "channel";
    return {
      domain: `${prefix}-${channel.id}`,
      readers: only(channel.members),
      epoch: epochOf(channel.members),
    };
  }

  /** The audience of a domain key, for checks made from inside a conversation. */
  audienceOfDomain(domain: string): Audience | undefined {
    if (domain === "public")
      return { domain, readers: EVERYONE, epoch: "public" };
    const match = /^(?:channel|dm)-(.+)$/.exec(domain);
    return match?.[1] === undefined ? undefined : this.audienceOf(match[1]);
  }
}

function parseMetadata(
  event: NostrEvent,
): Pick<ChannelInfo, "name" | "type" | "visibility" | "archived"> {
  const declared = tagValue(event, "t");
  const hidden = event.tags.some((tag) => tag[0] === "hidden");
  const isPrivate = event.tags.some((tag) => tag[0] === "private");
  const type: ChannelType =
    declared === "dm" || hidden
      ? "dm"
      : declared === "stream" || declared === "forum" || declared === "workflow"
        ? declared
        : "unknown";
  return {
    name: tagValue(event, "name") ?? "unknown",
    type,
    // A DM is never open, whatever its tags say.
    visibility: isPrivate || type === "dm" ? "private" : "open",
    archived: tagValue(event, "archived") === "true",
  };
}

function epochOf(members: ReadonlySet<string>): string {
  return createHash("sha256")
    .update([...members].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}
