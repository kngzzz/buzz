import { canFlowTo } from "../ifc/labels.ts";
import type { Logger } from "../log.ts";
import {
  channelOf,
  type EventTemplate,
  Kind,
  MESSAGE_KINDS,
  type NostrEvent,
  nowSeconds,
} from "../nostr/event.ts";
import type { Signer } from "../nostr/signer.ts";
import type { PublishResult, RelayClient } from "../relay/client.ts";
import type { Directory } from "./directory.ts";

/** Why the broker refused an operation. Never says anything about the refused content. */
export class BrokerRefusal extends Error {}

/**
 * Keeper's trusted core. It alone holds the signing key, and every Buzz read
 * and write a conversation asks for passes its information-flow checks:
 *
 * - read:    domain D may read x only if A(D) ⊆ R(x)
 * - publish: domain D may publish to d only if A(d) ⊆ A(D)
 *
 * Operation names follow the agent-broker contract in
 * `crates/buzz-sdk/src/broker` (`channel.read`, `message.reply`, `reaction.add`)
 * so the same checks can later serve keyless agents over that contract.
 */
export class Broker {
  readonly pubkey: string;
  readonly #signer: Signer;
  readonly #relay: RelayClient;
  readonly #directory: Directory;
  readonly #log: Logger;
  readonly #names = new Map<
    string,
    { name: string; bot: boolean; at: number }
  >();

  constructor(options: {
    signer: Signer;
    relay: RelayClient;
    directory: Directory;
    log: Logger;
  }) {
    this.#signer = options.signer;
    this.#relay = options.relay;
    this.#directory = options.directory;
    this.#log = options.log;
    this.pubkey = options.signer.pubkey;
  }

  /**
   * Whether `domain` may read content of `channelId`: A(D) ⊆ R(x), and, in
   * this phase, only content whose readers grow along with the domain's own —
   * open channels, or the domain's own channel. A private channel whose members
   * happen to include today's audience is excluded, because its content would
   * leak if this channel later gained a member (spec §9.3).
   */
  mayRead(domain: string, channelId: string): boolean {
    const audience = this.#directory.audienceOfDomain(domain);
    const readers = this.#directory.readers(channelId);
    if (
      audience === undefined ||
      readers === undefined ||
      !canFlowTo(readers, audience.readers)
    )
      return false;
    return (
      readers.kind === "everyone" ||
      this.#directory.audienceOf(channelId)?.domain === domain
    );
  }

  /** Whether output of `domain` may be published into `channelId`. */
  mayPublish(domain: string, channelId: string): boolean {
    const audience = this.#directory.audienceOfDomain(domain);
    const destination = this.#directory.readers(channelId);
    return (
      audience !== undefined &&
      destination !== undefined &&
      canFlowTo(audience.readers, destination)
    );
  }

  /** `channel.read`: messages of a channel or one thread, oldest first. */
  async channelRead(
    domain: string,
    args: { channelId: string; rootEventId?: string; limit?: number },
  ): Promise<NostrEvent[]> {
    if (!this.mayRead(domain, args.channelId)) {
      throw new BrokerRefusal(
        "That channel is not readable from this conversation.",
      );
    }
    const limit = Math.min(args.limit ?? 200, 500);
    const filters =
      args.rootEventId === undefined
        ? [{ kinds: MESSAGE_KINDS, "#h": [args.channelId], limit }]
        : [
            { kinds: MESSAGE_KINDS, ids: [args.rootEventId] },
            {
              kinds: MESSAGE_KINDS,
              "#h": [args.channelId],
              "#e": [args.rootEventId],
              limit,
            },
          ];
    const events = await this.#relay.query(filters);
    const unique = new Map(events.map((event) => [event.id, event]));
    return [...unique.values()]
      .filter((event) => channelOf(event) === args.channelId)
      .sort((a, b) => a.created_at - b.created_at);
  }

  /**
   * Full-text search (NIP-50). The relay returns what Keeper can read; the
   * broker keeps only hits from channels this domain may read.
   */
  async search(
    domain: string,
    query: string,
    limit = 20,
  ): Promise<NostrEvent[]> {
    const hits = await this.#relay.query([
      { kinds: MESSAGE_KINDS, search: query, limit: Math.min(limit, 100) },
    ]);
    return hits.filter((event) => {
      const channelId = channelOf(event);
      return channelId !== undefined && this.mayRead(domain, channelId);
    });
  }

  /** Sign a reply into `channelId` after checking the destination. */
  signForChannel(
    domain: string,
    channelId: string,
    template: EventTemplate,
  ): NostrEvent {
    if (!this.mayPublish(domain, channelId)) {
      throw new BrokerRefusal(
        "This conversation's output may not be posted there.",
      );
    }
    return this.#signer.sign(template);
  }

  /**
   * Publish a signed event, repairing the one failure a retry can hit: a
   * memoized event older than the relay's ±900 s timestamp window. If the relay
   * already stored it, that counts as success; otherwise the caller re-signs.
   */
  async publish(
    event: NostrEvent,
  ): Promise<PublishResult & { readonly stale?: true }> {
    const result = await this.#relay.publish(event);
    if (result.ok || !/timestamp/i.test(result.message)) return result;
    const stored = await this.#relay.query([
      { kinds: [event.kind], ids: [event.id] },
    ]);
    if (stored.length > 0) return { ok: true, message: "already stored" };
    return { ...result, stale: true };
  }

  /** `reaction.add`, best effort: acknowledgements must never block work. */
  react(target: NostrEvent, emoji: string): void {
    const event = this.#signer.sign({
      kind: Kind.Reaction,
      created_at: nowSeconds(),
      tags: [["e", target.id]],
      content: emoji,
    });
    this.#relay.publish(event, 10_000).then(
      (result) => {
        if (!result.ok)
          this.#log.debug("reaction refused", { message: result.message });
      },
      () => {},
    );
  }

  /** Ephemeral typing indicator in a thread. */
  typing(channelId: string, root: string | null, parent: string | null): void {
    const tags: string[][] = [["h", channelId]];
    if (parent !== null) {
      if (root !== null && root !== parent) tags.push(["e", root, "", "root"]);
      tags.push(["e", parent, "", "reply"]);
    }
    this.#relay.send(
      this.#signer.sign({
        kind: Kind.TypingIndicator,
        created_at: nowSeconds(),
        tags,
        content: "",
      }),
    );
  }

  /** Publish Keeper's own profile. */
  async publishProfile(profile: {
    name: string;
    about: string;
  }): Promise<void> {
    const event = this.#signer.sign({
      kind: Kind.Profile,
      created_at: nowSeconds(),
      tags: [],
      content: JSON.stringify({
        name: profile.name,
        display_name: profile.name,
        about: profile.about,
        bot: true,
      }),
    });
    const result = await this.#relay.publish(event);
    if (!result.ok)
      this.#log.warn("profile publish refused", { message: result.message });
  }

  /** Display name for attribution, cached for ten minutes. */
  async displayName(pubkey: string): Promise<string> {
    return (await this.#profile(pubkey)).name;
  }

  /** Whether a profile already fetched says this pubkey is an agent (`bot: true`). */
  isKnownAgent(pubkey: string): boolean {
    return this.#names.get(pubkey)?.bot === true;
  }

  async #profile(
    pubkey: string,
  ): Promise<{ name: string; bot: boolean; at: number }> {
    const cached = this.#names.get(pubkey);
    if (cached !== undefined && Date.now() - cached.at < 600_000) return cached;
    const profile = {
      name: `${pubkey.slice(0, 8)}…`,
      bot: false,
      at: Date.now(),
    };
    try {
      const [event] = await this.#relay.query(
        [{ kinds: [Kind.Profile], authors: [pubkey], limit: 1 }],
        5_000,
      );
      if (event !== undefined) {
        const parsed = JSON.parse(event.content) as {
          display_name?: unknown;
          name?: unknown;
          bot?: unknown;
        };
        const candidate = parsed.display_name ?? parsed.name;
        if (typeof candidate === "string" && candidate.trim() !== "")
          profile.name = candidate.trim();
        profile.bot = parsed.bot === true;
      }
    } catch {
      // Attribution falls back to the short key; never fail a request over a name.
    }
    this.#names.set(pubkey, profile);
    return profile;
  }
}
