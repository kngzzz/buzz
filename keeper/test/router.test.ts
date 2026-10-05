import { describe, expect, it } from "vitest";
import type { ChannelInfo } from "../src/broker/directory.ts";
import { Kind, type NostrEvent } from "../src/nostr/event.ts";
import { REPORT_TAG } from "../src/runtime/docs.ts";
import {
  controlOf,
  type RouteInput,
  route,
  threadOf,
} from "../src/service/router.ts";

const SELF = "f".repeat(64);
const ALICE = "a".repeat(64);
const AGENT = "b".repeat(64);
const ROOT = "1".repeat(64);
const PARENT = "2".repeat(64);

const channel = (overrides: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id: "c1",
  name: "launch",
  type: "stream",
  visibility: "open",
  archived: false,
  members: new Set([ALICE, SELF]),
  ...overrides,
});

const event = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: "9".repeat(64),
  pubkey: ALICE,
  created_at: 1_700_000_000,
  kind: Kind.StreamMessage,
  tags: [["h", "c1"]],
  content: "hello",
  sig: "",
  ...overrides,
});

const input = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  event: event(),
  self: SELF,
  channel: channel(),
  hasConversation: () => false,
  isAgent: (pubkey) => pubkey === AGENT,
  allowedAgents: new Set(),
  ...overrides,
});

describe("route", () => {
  it.each([
    {
      name: "a mention is a request",
      input: input({
        event: event({
          tags: [
            ["h", "c1"],
            ["p", SELF],
          ],
        }),
      }),
      type: "request",
    },
    {
      name: "an unaddressed message outside Keeper's threads is ignored",
      input: input(),
      type: "ignore",
    },
    {
      name: "an unaddressed message in Keeper's thread is context",
      input: input({ hasConversation: () => true }),
      type: "context",
    },
    {
      name: "Keeper's own message is ignored",
      input: input({
        event: event({
          pubkey: SELF,
          tags: [
            ["h", "c1"],
            ["p", SELF],
          ],
        }),
      }),
      type: "ignore",
    },
    {
      name: "Keeper's own research report becomes context in its thread",
      input: input({
        event: event({
          pubkey: SELF,
          tags: [
            ["h", "c1"],
            [REPORT_TAG, "job-1"],
          ],
        }),
        hasConversation: () => true,
      }),
      type: "context",
    },
    {
      name: "a 1:1 DM is always a request",
      input: input({ channel: channel({ type: "dm", visibility: "private" }) }),
      type: "request",
    },
    {
      name: "a group DM needs a mention",
      input: input({
        channel: channel({
          type: "dm",
          visibility: "private",
          members: new Set([ALICE, SELF, AGENT]),
        }),
      }),
      type: "ignore",
    },
    {
      name: "an agent's mention is ignored",
      input: input({
        event: event({
          pubkey: AGENT,
          tags: [
            ["h", "c1"],
            ["p", SELF],
          ],
        }),
      }),
      type: "ignore",
    },
    {
      name: "an allowlisted agent's mention is a request",
      input: input({
        event: event({
          pubkey: AGENT,
          tags: [
            ["h", "c1"],
            ["p", SELF],
          ],
        }),
        allowedAgents: new Set([AGENT]),
      }),
      type: "request",
    },
    {
      name: "a stop phrase is a control",
      input: input({
        event: event({
          tags: [
            ["h", "c1"],
            ["p", SELF],
          ],
          content: "@Keeper stop",
        }),
      }),
      type: "control",
    },
    {
      name: "an unknown channel is ignored",
      input: input({ channel: undefined }),
      type: "ignore",
    },
    {
      name: "an edit is routed to its target",
      input: input({
        event: event({
          kind: Kind.StreamMessageEdit,
          tags: [
            ["h", "c1"],
            ["e", ROOT],
          ],
        }),
      }),
      type: "edit",
    },
    {
      name: "a deletion is routed to its target",
      input: input({
        event: event({ kind: Kind.Deletion, tags: [["e", ROOT]] }),
      }),
      type: "delete",
    },
    {
      name: "a member list update is routed",
      input: input({
        event: event({ kind: Kind.ChannelMembers, tags: [["d", "c1"]] }),
      }),
      type: "members",
    },
    {
      name: "a reaction is ignored",
      input: input({ event: event({ kind: Kind.Reaction }) }),
      type: "ignore",
    },
  ])("$name", ({ input: given, type }) => {
    expect(route(given, ["Keeper"]).type).toBe(type);
  });
});

describe("threadOf", () => {
  it("roots a top-level message at itself", () => {
    expect(threadOf(event(), channel())).toEqual({
      key: `c1:${"9".repeat(64)}`,
      channelId: "c1",
      root: "9".repeat(64),
      dm: false,
    });
  });

  it("puts a nested reply in its root's thread", () => {
    const reply = event({
      tags: [
        ["h", "c1"],
        ["e", ROOT, "", "root"],
        ["e", PARENT, "", "reply"],
      ],
    });
    expect(threadOf(reply, channel()).key).toBe(`c1:${ROOT}`);
  });

  it("gives a DM one conversation", () => {
    expect(threadOf(event(), channel({ type: "dm" }))).toEqual({
      key: "dm:c1",
      channelId: "c1",
      root: null,
      dm: true,
    });
  });
});

describe("controlOf", () => {
  it.each([
    ["@Keeper stop", "stop"],
    ["stop.", "stop"],
    ["@keeper /status", "status"],
    ["cancel", "stop"],
    ["@Keeper stop the build please", undefined],
    ["status of the launch?", undefined],
  ] as const)("%s", (content, expected) => {
    expect(controlOf(content, ["Keeper"])).toBe(expected);
  });
});
