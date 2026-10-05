import { describe, expect, it } from "vitest";
import { mentions, replyTags, threadPosition } from "../src/nostr/event.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("threadPosition follows crates/buzz-core/src/nip10.rs", () => {
  it.each([
    { name: "no e tags is top-level", tags: [], expected: undefined },
    {
      name: "root alone is top-level",
      tags: [["e", A, "", "root"]],
      expected: undefined,
    },
    {
      name: "reply alone is a direct reply to the root",
      tags: [["e", A, "", "reply"]],
      expected: { root: A, parent: A },
    },
    {
      name: "root and reply give root and parent",
      tags: [
        ["e", A, "", "root"],
        ["e", B, "", "reply"],
      ],
      expected: { root: A, parent: B },
    },
    {
      name: "marker order does not matter",
      tags: [
        ["e", B, "", "reply"],
        ["e", A, "", "root"],
      ],
      expected: { root: A, parent: B },
    },
    {
      name: "unmarked e tags are ignored",
      tags: [
        ["e", C],
        ["e", A, "", "reply"],
      ],
      expected: { root: A, parent: A },
    },
    {
      name: "malformed ids are ignored",
      tags: [["e", "not-hex", "", "reply"]],
      expected: undefined,
    },
  ])("$name", ({ tags, expected }) => {
    expect(threadPosition({ tags })).toEqual(expected);
  });
});

describe("replyTags round-trips through threadPosition", () => {
  it.each([
    { root: A, parent: A },
    { root: A, parent: B },
  ])("root=$root parent=$parent", ({ root, parent }) => {
    expect(threadPosition({ tags: replyTags(root, parent) })).toEqual({
      root,
      parent,
    });
  });
});

describe("mentions", () => {
  it("matches a p tag case-insensitively", () => {
    expect(mentions({ tags: [["p", A.toUpperCase()]] }, A)).toBe(true);
  });

  it("ignores other tags and other pubkeys", () => {
    expect(
      mentions(
        {
          tags: [
            ["e", A],
            ["p", B],
          ],
        },
        A,
      ),
    ).toBe(false);
  });
});
