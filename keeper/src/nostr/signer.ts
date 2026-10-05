import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import type { EventTemplate, NostrEvent } from "./event.ts";

/**
 * Holds Keeper's signing key. Only the broker and the relay client's NIP-42
 * handshake receive a `Signer`; tools, prompts and sandboxes never do.
 */
export class Signer {
  readonly pubkey: string;
  readonly #secret: Uint8Array;

  constructor(secret: Uint8Array) {
    this.#secret = secret;
    this.pubkey = getPublicKey(secret);
  }

  /** Parse a 64-character hex secret or an `nsec1…` string. */
  static parse(value: string): Signer {
    const trimmed = value.trim();
    if (trimmed.startsWith("nsec1")) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec") throw new Error("expected an nsec key");
      return new Signer(decoded.data);
    }
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      throw new Error("private key must be 64 hex characters or an nsec");
    }
    return new Signer(Uint8Array.from(Buffer.from(trimmed, "hex")));
  }

  sign(template: EventTemplate): NostrEvent {
    const signed = finalizeEvent(
      {
        kind: template.kind,
        created_at: template.created_at,
        tags: template.tags.map((tag) => [...tag]),
        content: template.content,
      },
      this.#secret,
    );
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    };
  }

  /** Redact the key from accidental logging. */
  toJSON(): { pubkey: string } {
    return { pubkey: this.pubkey };
  }
}
