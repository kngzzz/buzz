import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAUX_MODEL, fauxBrain } from "../src/agent/faux-brain.ts";
import { silentLogger } from "../src/log.ts";
import {
  Kind,
  type NostrEvent,
  nowSeconds,
  tagValue,
} from "../src/nostr/event.ts";
import { Signer } from "../src/nostr/signer.ts";
import { REPORT_TAG } from "../src/runtime/docs.ts";
import { Keeper } from "../src/service/keeper.ts";
import { FakeRelay } from "./fake-relay.ts";

/**
 * Keeper end to end against the fake relay, with the scripted demo brain in
 * place of a model: everything but the model is the production path.
 */

const keeperKey = Signer.parse("2".repeat(64));
const alice = Signer.parse("3".repeat(64));
const bob = Signer.parse("4".repeat(64));
const robot = Signer.parse("6".repeat(64));

let relay: FakeRelay;
let dataDir: string;
let general: string;
let launch: string;
let dm: string;
let running: Keeper[];

beforeEach(async () => {
  relay = await FakeRelay.start();
  dataDir = await mkdtemp(path.join(tmpdir(), "keeper-e2e-"));
  running = [];
  const everyone = [alice.pubkey, bob.pubkey, robot.pubkey, keeperKey.pubkey];
  general = relay.channel({ name: "general", members: everyone });
  launch = relay.channel({
    name: "launch",
    visibility: "private",
    members: [alice.pubkey, keeperKey.pubkey],
  });
  dm = relay.channel({
    name: "dm",
    type: "dm",
    members: [alice.pubkey, keeperKey.pubkey],
  });
  relay.inject(alice, {
    kind: Kind.Profile,
    tags: [],
    content: JSON.stringify({ name: "Alice" }),
  });
  relay.inject(bob, {
    kind: Kind.Profile,
    tags: [],
    content: JSON.stringify({ name: "Bob" }),
  });
  relay.inject(robot, {
    kind: Kind.Profile,
    tags: [],
    content: JSON.stringify({ name: "Robot", bot: true }),
  });
});

afterEach(async () => {
  for (const keeper of running) await keeper.stop();
  await relay.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function startKeeper(): Promise<Keeper> {
  const models = createModels();
  models.setProvider(fauxBrain().provider);
  const keeper = await Keeper.start({
    relayUrl: relay.url,
    signer: keeperKey,
    dataDir,
    name: "Keeper",
    about: "Research assistant",
    models,
    model: FAUX_MODEL,
    fetchPage: () => Promise.reject(new Error("no network in tests")),
    log: silentLogger,
    typingIntervalMs: 60_000,
    retryBaseMs: 50,
  });
  running.push(keeper);
  return keeper;
}

const MENTION = ["p", keeperKey.pubkey];

function say(
  signer: Signer,
  channelId: string,
  content: string,
  tags: string[][] = [],
): NostrEvent {
  return relay.inject(signer, {
    kind: Kind.StreamMessage,
    tags: [["h", channelId], ...tags],
    content,
  });
}

const fromKeeper = (event: NostrEvent) =>
  event.pubkey === keeperKey.pubkey && event.kind === Kind.StreamMessage;

/** Keeper's messages that reply to `id` (NIP-10 `reply` marker). */
const repliesTo = (id: string) => (event: NostrEvent) =>
  fromKeeper(event) &&
  event.tags.some(
    (tag) => tag[0] === "e" && tag[1] === id && tag[3] === "reply",
  );

const isReport = (event: NostrEvent) =>
  fromKeeper(event) && event.tags.some((tag) => tag[0] === REPORT_TAG);

/** Give duplicates, if any, time to show up. */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Keeper", () => {
  it("answers a mention once, in its thread, and acknowledges it", async () => {
    await startKeeper();
    const mention = say(alice, general, "@Keeper hello there", [MENTION]);

    const reply = await relay.waitFor(repliesTo(mention.id));
    expect(reply.content).toContain("Hi Alice!");
    expect(reply.content).toContain("hello there");
    expect(reply.tags).toContainEqual(["h", general]);
    expect(reply.tags).toContainEqual(["p", alice.pubkey]);
    await relay.waitFor(
      (event) =>
        event.kind === Kind.Reaction &&
        event.pubkey === keeperKey.pubkey &&
        tagValue(event, "e") === mention.id,
    );
    await settle();
    expect(relay.events.filter(repliesTo(mention.id))).toHaveLength(1);
  });

  it("reads the thread it is asked about", async () => {
    await startKeeper();
    const root = say(alice, general, "Should we launch on Tuesday?");
    say(bob, general, "Thursday is safer.", [["e", root.id, "", "reply"]]);
    const ask = say(alice, general, "@Keeper summarize this", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);

    const reply = await relay.waitFor(repliesTo(ask.id));
    expect(reply.content).toContain("3 messages from Alice, Bob");
    expect(reply.tags).toContainEqual(["e", root.id, "", "root"]);
  });

  it("follows its thread: history before it was asked, later messages, and deletions", async () => {
    await startKeeper();
    const root = say(alice, general, "Kickoff notes");
    const agenda = say(bob, general, "Agenda attached", [
      ["e", root.id, "", "reply"],
    ]);
    const first = say(alice, general, "@Keeper hello", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);
    expect((await relay.waitFor(repliesTo(first.id))).content).toContain(
      "I can see 2 earlier messages",
    );

    say(bob, general, "One more thing", [["e", root.id, "", "reply"]]);
    relay.inject(bob, {
      kind: Kind.Deletion,
      tags: [
        ["h", general],
        ["e", agenda.id],
      ],
      content: "",
    });
    const second = say(alice, general, "@Keeper hello again", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);
    // Kickoff, the first request and "One more thing"; the deleted agenda is gone.
    expect((await relay.waitFor(repliesTo(second.id))).content).toContain(
      "I can see 3 earlier messages",
    );
  });

  it("answers every message in a one-to-one DM, without thread tags", async () => {
    await startKeeper();
    say(alice, dm, "can you help?");

    const reply = await relay.waitFor(
      (event) => fromKeeper(event) && tagValue(event, "h") === dm,
    );
    expect(reply.content).toContain("You said: “can you help?”");
    expect(reply.tags.filter((tag) => tag[0] === "e")).toEqual([]);
    expect(reply.tags).toContainEqual(["p", alice.pubkey]);
  });

  it("ignores mentions from agents that are not allowed to wake it", async () => {
    await startKeeper();
    const fromAgent = say(robot, general, "@Keeper hello", [MENTION]);
    const fromPerson = say(alice, general, "@Keeper hello", [MENTION]);

    await relay.waitFor(repliesTo(fromPerson.id));
    await settle();
    expect(relay.events.filter(repliesTo(fromAgent.id))).toEqual([]);
  });

  it("runs research in the background and posts one report in the thread", async () => {
    await startKeeper();
    const ask = say(
      alice,
      general,
      "@Keeper research what competitors charge",
      [MENTION],
    );

    const ack = await relay.waitFor(repliesTo(ask.id));
    expect(ack.content).toContain("On it");
    const report = await relay.waitFor(isReport);
    expect(report.content).toContain(
      "📋 **Research report:** what competitors charge",
    );
    expect(report.content).toContain(
      "Demo report for: what competitors charge",
    );
    expect(report.tags).toContainEqual(["e", ask.id, "", "reply"]);
    expect(report.tags).toContainEqual(["p", alice.pubkey]);

    const status = say(alice, general, "@Keeper status", [
      ["e", ask.id, "", "reply"],
      MENTION,
    ]);
    const notice = await relay.waitFor(repliesTo(status.id));
    expect(notice.content).toMatch(
      /Research job-\d+: (running|posted) — what competitors charge/,
    );
    await settle();
    expect(relay.events.filter(isReport)).toHaveLength(1);
  });

  it("keeps research in an open channel away from private channels", async () => {
    say(alice, launch, "pricing secret: we charge 42");
    await startKeeper();
    say(alice, general, "@Keeper research pricing", [MENTION]);

    const report = await relay.waitFor(isReport);
    expect(tagValue(report, "h")).toBe(general);
    expect(report.content).toContain("in #general");
    expect(report.content).not.toContain("#launch");
  });

  it("researches a private channel's own messages and reports only there", async () => {
    say(alice, launch, "pricing secret: we charge 42");
    await startKeeper();
    say(alice, launch, "@Keeper research pricing", [MENTION]);

    const report = await relay.waitFor(isReport);
    expect(tagValue(report, "h")).toBe(launch);
    expect(report.content).toContain("in #launch");
  });

  it("posts a reply exactly once across a restart that lost the relay's OK", async () => {
    const first = await startKeeper();
    relay.swallowOk = fromKeeper;
    const mention = say(alice, general, "@Keeper are you there?", [MENTION]);
    const reply = await relay.waitFor(repliesTo(mention.id));

    // Keeper never heard that the reply landed; stop it while it still owes one,
    // and restart in a later second, so a reply signed afresh would get a new id.
    await first.stop();
    await waitUntil(() => nowSeconds() > reply.created_at);
    running = running.filter((keeper) => keeper !== first);
    relay.swallowOk = undefined;
    await startKeeper();

    // The reply task resumes and publishes the same signed event; the relay keeps one.
    await waitUntil(
      () => relay.received.filter((event) => event.id === reply.id).length >= 2,
    );
    await settle();
    expect(relay.events.filter(repliesTo(mention.id))).toEqual([reply]);
  });

  it("does not repeat a control command when a restart replays it", async () => {
    const first = await startKeeper();
    const ask = say(alice, general, "@Keeper hello", [MENTION]);
    await relay.waitFor(repliesTo(ask.id));
    const status = say(alice, general, "@Keeper status", [
      ["e", ask.id, "", "reply"],
      MENTION,
    ]);
    const notice = await relay.waitFor(repliesTo(status.id));

    // Restart in a later second, so a repeated notice could not share its id.
    await first.stop();
    running = running.filter((keeper) => keeper !== first);
    await waitUntil(() => nowSeconds() > notice.created_at);
    await startKeeper();
    // The restart replays the channel, status command included; a later
    // request in the thread shows the replay has been processed.
    const later = say(alice, general, "@Keeper still there?", [
      ["e", ask.id, "", "reply"],
      MENTION,
    ]);
    await relay.waitFor(repliesTo(later.id));
    await settle();
    expect(relay.events.filter(repliesTo(status.id))).toHaveLength(1);
  });

  it("retries a request whose admission failed", async () => {
    await startKeeper();
    let failed = false;
    relay.failQuery = (filters) => {
      if (failed || !filters.some((filter) => filter["#e"] !== undefined))
        return undefined;
      failed = true;
      return "error: database unavailable";
    };
    const root = say(bob, general, "Root message");
    const ask = say(alice, general, "@Keeper hello", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);

    const reply = await relay.waitFor(repliesTo(ask.id));
    expect(failed).toBe(true);
    expect(reply.content).toContain("Hi Alice!");
  });

  it("tells the thread when it cannot take a request", async () => {
    await startKeeper();
    relay.failQuery = (filters) =>
      filters.some((filter) => filter["#e"] !== undefined)
        ? "error: database unavailable"
        : undefined;
    const root = say(bob, general, "Root message");
    const ask = say(alice, general, "@Keeper hello", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);

    const notice = await relay.waitFor(repliesTo(ask.id));
    expect(notice.content).toContain("couldn't take this request");
  });
});

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
