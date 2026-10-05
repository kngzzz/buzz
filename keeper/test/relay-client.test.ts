import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.ts";
import { Kind, type NostrEvent, nowSeconds } from "../src/nostr/event.ts";
import { Signer } from "../src/nostr/signer.ts";
import { RelayClient } from "../src/relay/client.ts";
import { FakeRelay } from "./fake-relay.ts";

const keeper = Signer.parse("2".repeat(64));
const alice = Signer.parse("3".repeat(64));

let relay: FakeRelay;
let client: RelayClient;

beforeEach(async () => {
  relay = await FakeRelay.start();
  client = new RelayClient({
    url: relay.url,
    signer: keeper,
    log: silentLogger,
    reconnect: { initialMs: 20, maxMs: 50 },
  });
  client.start();
  await client.waitReady();
});

afterEach(async () => {
  await client.stop();
  await relay.close();
});

const message = (content: string, channel: string) => ({
  kind: Kind.StreamMessage,
  tags: [["h", channel]],
  content,
});

describe("RelayClient", () => {
  it("authenticates with NIP-42 before reading", async () => {
    relay.inject(alice, message("hello", "c1"));
    const events = await client.query([
      { kinds: [Kind.StreamMessage], "#h": ["c1"] },
    ]);
    expect(events.map((event) => event.content)).toEqual(["hello"]);
  });

  it("publishes and waits for OK", async () => {
    const event = keeper.sign({
      ...message("from keeper", "c1"),
      created_at: nowSeconds(),
    });
    await expect(client.publish(event)).resolves.toEqual({
      ok: true,
      message: "",
    });
    expect(relay.events.some((stored) => stored.id === event.id)).toBe(true);
  });

  it("treats a duplicate publish as success", async () => {
    const event = keeper.sign({
      ...message("once", "c1"),
      created_at: nowSeconds(),
    });
    await client.publish(event);
    const again = await client.publish(event);
    expect(again.ok).toBe(true);
    expect(
      relay.events.filter((stored) => stored.id === event.id),
    ).toHaveLength(1);
  });

  it("delivers history then live events, and resubscribes after a reconnect", async () => {
    relay.inject(alice, message("before", "c1"));
    const seen: NostrEvent[] = [];
    let since = 0;
    client.subscribe(
      "live",
      () => [{ kinds: [Kind.StreamMessage], "#h": ["c1"], since }],
      {
        onEvent: (event) => {
          seen.push(event);
          since = event.created_at;
        },
      },
    );
    await waitUntil(() => seen.length === 1);

    relay.inject(alice, message("live", "c1"));
    await waitUntil(() => seen.some((event) => event.content === "live"));

    relay.dropConnections();
    await waitUntil(() => !client.ready);
    await client.waitReady();
    relay.inject(alice, message("after reconnect", "c1"));
    await waitUntil(() =>
      seen.some((event) => event.content === "after reconnect"),
    );
  });

  it("re-sends a publish whose OK was lost when the connection dropped", async () => {
    const event = keeper.sign({
      ...message("lost ok", "c1"),
      created_at: nowSeconds(),
    });
    relay.swallowOk = (candidate) => candidate.id === event.id;
    const result = client.publish(event, 5_000);
    await relay.waitFor((stored) => stored.id === event.id);
    relay.swallowOk = undefined;
    relay.dropConnections();
    await expect(result).resolves.toEqual({
      ok: true,
      message: "duplicate: already have this event",
    });
  });
});

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
