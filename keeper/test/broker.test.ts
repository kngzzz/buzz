import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker, BrokerRefusal } from "../src/broker/broker.ts";
import { Directory } from "../src/broker/directory.ts";
import { silentLogger } from "../src/log.ts";
import { Kind } from "../src/nostr/event.ts";
import { Signer } from "../src/nostr/signer.ts";
import { RelayClient } from "../src/relay/client.ts";
import { FakeRelay } from "./fake-relay.ts";

const keeper = Signer.parse("2".repeat(64));
const alice = Signer.parse("3".repeat(64));
const bob = Signer.parse("4".repeat(64));
const carol = Signer.parse("5".repeat(64));

let relay: FakeRelay;
let client: RelayClient;
let directory: Directory;
let broker: Broker;
const ids = { general: "", launch: "", launchTwin: "", dm: "" };

beforeEach(async () => {
  relay = await FakeRelay.start();
  ids.general = relay.channel({
    name: "general",
    members: [alice.pubkey, bob.pubkey, keeper.pubkey],
  });
  ids.launch = relay.channel({
    name: "launch",
    visibility: "private",
    members: [alice.pubkey, keeper.pubkey],
  });
  ids.launchTwin = relay.channel({
    name: "launch-twin",
    visibility: "private",
    members: [alice.pubkey, bob.pubkey, keeper.pubkey],
  });
  ids.dm = relay.channel({
    name: "dm",
    type: "dm",
    members: [alice.pubkey, keeper.pubkey],
  });
  client = new RelayClient({
    url: relay.url,
    signer: keeper,
    log: silentLogger,
  });
  client.start();
  await client.waitReady();
  directory = new Directory();
  for (const event of await client.query([
    { kinds: [Kind.ChannelMetadata, Kind.ChannelMembers] },
  ])) {
    directory.apply(event);
  }
  broker = new Broker({
    signer: keeper,
    relay: client,
    directory,
    log: silentLogger,
  });
});

afterEach(async () => {
  await client.stop();
  await relay.close();
});

const say = (signer: Signer, channelId: string, content: string) =>
  relay.inject(signer, {
    kind: Kind.StreamMessage,
    tags: [["h", channelId]],
    content,
  });

describe("information flow through the broker", () => {
  it("never returns private hits to the public domain", async () => {
    say(alice, ids.launch, "the secret price is 42");
    say(bob, ids.general, "the secret handshake is public");
    const hits = await broker.search("public", "secret");
    expect(hits.map((hit) => hit.content)).toEqual([
      "the secret handshake is public",
    ]);
  });

  it("returns a private channel's own content to its own domain", async () => {
    say(alice, ids.launch, "the secret price is 42");
    const hits = await broker.search(`channel-${ids.launch}`, "secret");
    expect(hits.map((hit) => hit.content)).toEqual(["the secret price is 42"]);
  });

  it("does not admit another private channel even when its members cover the audience", async () => {
    // launch-twin's members include everyone in launch, so A(D) ⊆ R(x) holds today, but launch
    // could gain a member tomorrow; this phase admits only open channels and the domain's own.
    say(bob, ids.launchTwin, "secret from the twin");
    expect(await broker.search(`channel-${ids.launch}`, "secret")).toEqual([]);
  });

  it.each([
    {
      name: "public reads an open channel",
      domain: "public",
      channel: "general",
      read: true,
    },
    {
      name: "public cannot read a private channel",
      domain: "public",
      channel: "launch",
      read: false,
    },
    {
      name: "public cannot read a DM",
      domain: "public",
      channel: "dm",
      read: false,
    },
    {
      name: "a private domain reads open channels",
      domain: "launch",
      channel: "general",
      read: true,
    },
    {
      name: "a private domain reads itself",
      domain: "launch",
      channel: "launch",
      read: true,
    },
    {
      name: "a private domain cannot read another private channel",
      domain: "launch",
      channel: "launchTwin",
      read: false,
    },
    {
      name: "a DM domain reads itself",
      domain: "dm",
      channel: "dm",
      read: true,
    },
  ] as const)("$name", ({ domain, channel, read }) => {
    const key =
      domain === "public"
        ? "public"
        : `${domain === "dm" ? "dm" : "channel"}-${ids[domain]}`;
    expect(broker.mayRead(key, ids[channel])).toBe(read);
  });

  it.each([
    {
      name: "public output may go anywhere",
      domain: "public",
      channel: "launch",
      publish: true,
    },
    {
      name: "private output may not go to an open channel",
      domain: "launch",
      channel: "general",
      publish: false,
    },
    {
      name: "private output may go back to its own channel",
      domain: "launch",
      channel: "launch",
      publish: true,
    },
    {
      name: "private output may not widen to a bigger private channel",
      domain: "launch",
      channel: "launchTwin",
      publish: false,
    },
    {
      name: "DM output may not go to an open channel",
      domain: "dm",
      channel: "general",
      publish: false,
    },
  ] as const)("$name", ({ domain, channel, publish }) => {
    const key =
      domain === "public"
        ? "public"
        : `${domain === "dm" ? "dm" : "channel"}-${ids[domain]}`;
    expect(broker.mayPublish(key, ids[channel])).toBe(publish);
  });

  it("refuses to sign a post that would widen the audience", () => {
    expect(() =>
      broker.signForChannel(`channel-${ids.launch}`, ids.general, {
        kind: Kind.StreamMessage,
        created_at: 1,
        tags: [["h", ids.general]],
        content: "leak",
      }),
    ).toThrow(BrokerRefusal);
  });

  it("refuses a thread read from a domain that may not see it", async () => {
    await expect(
      broker.channelRead("public", { channelId: ids.launch }),
    ).rejects.toThrow(BrokerRefusal);
  });

  it("decides from the current relay-signed member lists", () => {
    const launch = `channel-${ids.launch}`;
    expect(broker.mayPublish(launch, ids.launchTwin)).toBe(false);
    // Once the twin's readers fit inside launch's audience, launch output may flow there…
    directory.apply(
      relay.setMembers(ids.launchTwin, [alice.pubkey, keeper.pubkey]),
    );
    expect(broker.mayPublish(launch, ids.launchTwin)).toBe(true);
    // …and when launch gains a member, its audience moves to a new epoch.
    const before = directory.audienceOf(ids.launch)?.epoch;
    directory.apply(
      relay.setMembers(ids.launch, [alice.pubkey, keeper.pubkey, carol.pubkey]),
    );
    expect(directory.audienceOf(ids.launch)?.epoch).not.toBe(before);
    expect(broker.mayPublish(launch, ids.launchTwin)).toBe(true);
  });
});
