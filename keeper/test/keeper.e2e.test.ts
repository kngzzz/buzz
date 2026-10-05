import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAUX_MODEL, fauxBrain } from "../src/agent/faux-brain.ts";
import type { SearchProvider } from "../src/agent/services.ts";
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

async function startKeeper(
  options: {
    readonly brain?: Parameters<typeof fauxBrain>[0];
    readonly search?: SearchProvider;
    readonly retryBaseMs?: number;
    readonly initialLookbackSeconds?: number;
  } = {},
): Promise<Keeper> {
  const models = createModels();
  models.setProvider(fauxBrain(options.brain).provider);
  const keeper = await Keeper.start({
    relayUrl: relay.url,
    signer: keeperKey,
    dataDir,
    name: "Keeper",
    about: "Research assistant",
    models,
    model: FAUX_MODEL,
    fetchPage: () => Promise.reject(new Error("no network in tests")),
    ...(options.search === undefined ? {} : { search: options.search }),
    log: silentLogger,
    typingIntervalMs: 60_000,
    retryBaseMs: options.retryBaseMs ?? 50,
    ...(options.initialLookbackSeconds === undefined
      ? {}
      : { initialLookbackSeconds: options.initialLookbackSeconds }),
  });
  running.push(keeper);
  return keeper;
}

/** Stop a Keeper and take it out of the cleanup list, as a crash or deploy would. */
async function stopKeeper(keeper: Keeper): Promise<void> {
  await keeper.stop();
  running = running.filter((candidate) => candidate !== keeper);
}

/** A promise with its resolver, for holding a model turn. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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

describe("Keeper under failure and change", () => {
  it("stops treating a channel as open once it turns private", async () => {
    const deal = relay.channel({
      name: "deal",
      members: [alice.pubkey, bob.pubkey, keeperKey.pubkey],
    });
    await startKeeper();
    say(alice, deal, "pricing: we will charge 42");
    relay.channel({
      id: deal,
      name: "deal",
      visibility: "private",
      members: [alice.pubkey, keeperKey.pubkey],
      at: nowSeconds() + 1,
    });
    const hello = say(alice, deal, "@Keeper hello", [MENTION]);
    await relay.waitFor(repliesTo(hello.id));
    // The request ran with the channel's new, private audience…
    expect(existsSync(path.join(dataDir, "domains", `channel-${deal}`))).toBe(
      true,
    );
    // …and research from an open channel no longer sees it.
    say(bob, general, "@Keeper research pricing", [MENTION]);
    const report = await relay.waitFor(isReport);
    expect(report.content).not.toContain("#deal");
  });

  it("gives research in a private channel no web access", async () => {
    const queries: string[] = [];
    const search: SearchProvider = {
      name: "fake",
      search: async (query) => {
        queries.push(query);
        return [
          { title: "Public page", url: "https://example.com", snippet: "web" },
        ];
      },
    };
    await startKeeper({ search });
    say(alice, launch, "@Keeper research pricing", [MENTION]);
    const privateReport = await relay.waitFor(isReport);
    expect(privateReport.content).not.toContain("Public page");
    expect(queries).toEqual([]);

    say(alice, general, "@Keeper research pricing", [MENTION]);
    const publicReport = await relay.waitFor(
      (event) => isReport(event) && tagValue(event, "h") === general,
    );
    expect(publicReport.content).toContain("Public page");
    expect(queries).toEqual(["pricing"]);
  });

  it("catches up on missed messages oldest first", async () => {
    const now = nowSeconds();
    const root = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general]],
      content: "Kickoff",
      created_at: now - 30,
    });
    const inThread = [["e", root.id, "", "reply"], MENTION];
    const first = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general], ...inThread],
      content: "@Keeper first",
      created_at: now - 20,
    });
    const second = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general], ...inThread],
      content: "@Keeper second",
      created_at: now - 10,
    });
    await startKeeper({ initialLookbackSeconds: 300 });
    expect((await relay.waitFor(repliesTo(first.id))).content).toContain(
      "I can see 1 earlier message ",
    );
    expect((await relay.waitFor(repliesTo(second.id))).content).toContain(
      "You said: “second”",
    );
  });

  it("reaches a request buried under more than a page of later messages", async () => {
    const now = nowSeconds();
    const ask = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general], MENTION],
      content: "@Keeper are you there?",
      created_at: now - 120,
    });
    for (let index = 0; index < 520; index++) {
      relay.inject(bob, {
        kind: Kind.StreamMessage,
        tags: [["h", general]],
        content: `chatter ${index}`,
        created_at: now - 100 + Math.floor(index / 10),
      });
    }
    await startKeeper({ initialLookbackSeconds: 300 });
    await relay.waitFor(repliesTo(ask.id));
  });

  it("pages back even when the first page holds only events already handled", async () => {
    const now = nowSeconds();
    // General stays quiet and keeps an old cursor; launch's ends up recent.
    relay.inject(bob, {
      kind: Kind.StreamMessage,
      tags: [["h", general]],
      content: "an old message",
      created_at: now - 4_000,
    });
    for (let index = 0; index < 520; index++) {
      relay.inject(alice, {
        kind: Kind.StreamMessage,
        tags: [["h", launch]],
        content: `old chatter ${index}`,
        created_at: now - 3_000 + index,
      });
    }
    const first = await startKeeper({ initialLookbackSeconds: 5_000 });
    const status = say(alice, launch, "@Keeper status", [MENTION]);
    const notice = await relay.waitFor(repliesTo(status.id));
    await waitUntil(() => (cursorOf(launch) ?? 0) >= notice.created_at);
    await stopKeeper(first);

    // A request this Keeper never saw, older than all of launch's chatter.
    const ask = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general], MENTION],
      content: "@Keeper hello",
      created_at: now - 3_500,
    });
    await startKeeper({ initialLookbackSeconds: 5_000 });
    await relay.waitFor(repliesTo(ask.id));
  });

  it("keeps its replay cursor below a request still being admitted", async () => {
    const held = gate();
    relay.holdQuery = (filters) =>
      filters.some((filter) => filter["#e"] !== undefined)
        ? held.promise
        : undefined;
    const now = nowSeconds();
    const root = relay.inject(bob, {
      kind: Kind.StreamMessage,
      tags: [["h", general]],
      content: "Root message",
      created_at: now - 50,
    });
    const ask = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", general], ["e", root.id, "", "reply"], MENTION],
      content: "@Keeper hello",
      created_at: now - 40,
    });
    relay.inject(bob, {
      kind: Kind.StreamMessage,
      tags: [["h", general]],
      content: "something else",
      created_at: now - 10,
    });
    await startKeeper({ initialLookbackSeconds: 300 });
    // The later message settles while the request waits on its thread read.
    await waitUntil(() => (cursorOf(general) ?? 0) >= now - 50);
    await settle();
    expect(cursorOf(general)).toBeLessThan(ask.created_at);

    held.open();
    await relay.waitFor(repliesTo(ask.id));
    await waitUntil(() => (cursorOf(general) ?? 0) >= now - 10);
  });

  it("does not replay a channel's old commands for a busier channel's sake", async () => {
    const now = nowSeconds();
    // General's cursor stays old, so the batch's replay reaches far back…
    relay.inject(bob, {
      kind: Kind.StreamMessage,
      tags: [["h", general]],
      content: "an old message",
      created_at: now - 3_000,
    });
    // …past launch's own window, where a status command was handled long ago.
    const status = relay.inject(alice, {
      kind: Kind.StreamMessage,
      tags: [["h", launch], MENTION],
      content: "@Keeper status",
      created_at: now - 2_000,
    });
    const first = await startKeeper({ initialLookbackSeconds: 5_000 });
    const notice = await relay.waitFor(repliesTo(status.id));
    // Keeper's own notice moves launch's cursor, so the command's record is
    // pruned at the next start: only the window keeps it from running again.
    await waitUntil(() => (cursorOf(launch) ?? 0) >= notice.created_at);
    await stopKeeper(first);
    await waitUntil(() => nowSeconds() > notice.created_at);

    await startKeeper({ initialLookbackSeconds: 5_000 });
    const later = say(alice, launch, "@Keeper hello", [MENTION]);
    await relay.waitFor(repliesTo(later.id));
    await settle();
    expect(relay.events.filter(repliesTo(status.id))).toHaveLength(1);
  });

  it("retries a failed stop notice without stopping again", async () => {
    const slow = gate();
    await startKeeper({
      retryBaseMs: 500,
      brain: {
        beforeTurn: (text) => (text === "slow one" ? slow.promise : undefined),
      },
    });
    const ask = say(alice, general, "@Keeper hello", [MENTION]);
    await relay.waitFor(repliesTo(ask.id));
    let stops = 0;
    relay.reject = (event) =>
      fromKeeper(event) && event.content === "Stopped." && stops++ === 0
        ? "rate-limited: slow down"
        : undefined;
    const inThread = [["e", ask.id, "", "reply"], MENTION];
    say(alice, general, "@Keeper stop", inThread);
    await waitUntil(() => stops === 1);
    const slowAsk = say(alice, general, "@Keeper slow one", inThread);
    await relay.waitFor(
      (event) => fromKeeper(event) && event.content === "Stopped.",
    );
    slow.open();
    expect((await relay.waitFor(repliesTo(slowAsk.id))).content).toContain(
      "You said: “slow one”",
    );
  });

  it("records a research report the relay refuses as failed", async () => {
    await startKeeper();
    relay.reject = (event) =>
      isReport(event) ? "blocked: reports are not allowed here" : undefined;
    const ask = say(alice, general, "@Keeper research pricing", [MENTION]);
    await relay.waitFor(repliesTo(ask.id));
    await waitUntil(() => relay.received.some(isReport));
    await settle();
    const status = say(alice, general, "@Keeper status", [
      ["e", ask.id, "", "reply"],
      MENTION,
    ]);
    expect((await relay.waitFor(repliesTo(status.id))).content).toMatch(
      /Research job-\d+: failed — pricing/,
    );
  });

  it("clears a retry record once a restart handles the event", async () => {
    relay.failQuery = (filters) =>
      filters.some((filter) => filter["#e"] !== undefined)
        ? "error: database unavailable"
        : undefined;
    const first = await startKeeper({ retryBaseMs: 60_000 });
    const root = say(bob, general, "Root message");
    const ask = say(alice, general, "@Keeper hello", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);
    await waitUntil(() => retryCount() === 1);
    await stopKeeper(first);

    relay.failQuery = undefined;
    await startKeeper();
    await relay.waitFor(repliesTo(ask.id));
    await waitUntil(() => retryCount() === 0);
  });

  it("applies a deletion after a restart, and takes thread history in once", async () => {
    const first = await startKeeper();
    const root = say(alice, general, "Kickoff");
    const inThread = [["e", root.id, "", "reply"]];
    const secret = say(bob, general, "the code is 42", inThread);
    const hello = say(alice, general, "@Keeper hello", [...inThread, MENTION]);
    expect((await relay.waitFor(repliesTo(hello.id))).content).toContain(
      "I can see 2 earlier messages",
    );
    await stopKeeper(first);

    // The restart replays the thread; its history must not enter twice.
    await startKeeper();
    const check = say(alice, general, "@Keeper check", [...inThread, MENTION]);
    expect((await relay.waitFor(repliesTo(check.id))).content).toContain(
      "I can see 3 earlier messages",
    );
    relay.inject(bob, {
      kind: Kind.Deletion,
      tags: [
        ["h", general],
        ["e", secret.id],
      ],
      content: "",
    });
    const again = say(alice, general, "@Keeper again", [...inThread, MENTION]);
    // Kickoff, hello and check; the deleted secret is gone.
    expect((await relay.waitFor(repliesTo(again.id))).content).toContain(
      "I can see 3 earlier messages",
    );
  });

  it("does not mistake an agent for a person when its profile cannot be read", async () => {
    let failed = false;
    relay.failQuery = (filters) => {
      const robotProfile = filters.some(
        (filter) =>
          filter.kinds.includes(Kind.Profile) &&
          filter.authors?.includes(robot.pubkey) === true,
      );
      if (failed || !robotProfile) return undefined;
      failed = true;
      return "error: query timed out";
    };
    await startKeeper();
    const fromAgent = say(robot, general, "@Keeper hello", [MENTION]);
    await waitUntil(() => failed);
    const fromPerson = say(alice, general, "@Keeper hello", [MENTION]);
    await relay.waitFor(repliesTo(fromPerson.id));
    await settle(500);
    expect(relay.events.filter(repliesTo(fromAgent.id))).toEqual([]);
  });

  it("retries the apology when the relay refuses it at first", async () => {
    await startKeeper();
    relay.failQuery = (filters) =>
      filters.some((filter) => filter["#e"] !== undefined)
        ? "error: database unavailable"
        : undefined;
    let apologies = 0;
    relay.reject = (event) =>
      fromKeeper(event) &&
      event.content.includes("couldn't take") &&
      apologies++ === 0
        ? "rate-limited: slow down"
        : undefined;
    const root = say(bob, general, "Root message");
    const ask = say(alice, general, "@Keeper hello", [
      ["e", root.id, "", "reply"],
      MENTION,
    ]);
    const notice = await relay.waitFor(repliesTo(ask.id));
    expect(notice.content).toContain("couldn't take this request");
    expect(apologies).toBe(2);
  });
});

/** The replay cursor Keeper saved for a channel. */
function cursorOf(channelId: string): number | undefined {
  const db = new DatabaseSync(path.join(dataDir, "control.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT created_at FROM cursors WHERE channel_id = ?")
      .get(channelId);
    return row === undefined ? undefined : Number(row.created_at);
  } finally {
    db.close();
  }
}

/** Retry records in Keeper's control store. */
function retryCount(): number {
  const db = new DatabaseSync(path.join(dataDir, "control.sqlite"), {
    readOnly: true,
  });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM retries").get()?.n);
  } finally {
    db.close();
  }
}

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
