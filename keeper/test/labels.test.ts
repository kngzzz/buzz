import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canFlowTo,
  EVERYONE,
  FlowState,
  join,
  only,
  type ReaderSet,
} from "../src/ifc/labels.ts";

// The same cases `crates/ifc-core/tests/reader_set_fixtures.rs` runs.
type Readers = "everyone" | string[];
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../crates/ifc-core/fixtures/reader-sets.json", import.meta.url),
    "utf8",
  ),
) as {
  canFlowTo: {
    name: string;
    source: Readers;
    destination: Readers;
    expected: boolean;
  }[];
  join: { name: string; left: Readers; right: Readers; expected: Readers }[];
};

const readers = (value: Readers): ReaderSet =>
  value === "everyone" ? EVERYONE : only(value);
const plain = (value: ReaderSet): Readers =>
  value.kind === "everyone" ? "everyone" : [...value.readers].sort();

describe("reader sets match ifc-core", () => {
  it.each(fixtures.canFlowTo)("canFlowTo: $name", (fixture) => {
    expect(
      canFlowTo(readers(fixture.source), readers(fixture.destination)),
    ).toBe(fixture.expected);
  });

  it.each(fixtures.join)("join: $name", (fixture) => {
    const expected =
      fixture.expected === "everyone"
        ? "everyone"
        : [...fixture.expected].sort();
    expect(plain(join(readers(fixture.left), readers(fixture.right)))).toEqual(
      expected,
    );
  });
});

describe("FlowState", () => {
  const universe = "community-a";

  it("allows egress to any destination before any input", () => {
    expect(
      new FlowState().checkEgress({ universe, readers: EVERYONE }),
    ).toBeUndefined();
  });

  it("refuses widening after private input", () => {
    const flow = new FlowState();
    flow.observe({ universe, readers: only(["alice", "bob"]) });
    expect(
      flow.checkEgress({ universe, readers: only(["alice"]) }),
    ).toBeUndefined();
    expect(flow.checkEgress({ universe, readers: EVERYONE })).toBe(
      "destination_widens_readers",
    );
  });

  it("intersects every observed input", () => {
    const flow = new FlowState();
    flow.observe({ universe, readers: only(["alice", "bob"]) });
    flow.observe({ universe, readers: only(["alice", "carol"]) });
    expect(flow.checkEgress({ universe, readers: only(["bob"]) })).toBe(
      "destination_widens_readers",
    );
    expect(
      flow.checkEgress({ universe, readers: only(["alice"]) }),
    ).toBeUndefined();
  });

  it("blocks egress forever after cross-universe input", () => {
    const flow = new FlowState();
    flow.observe({ universe, readers: EVERYONE });
    flow.observe({ universe: "community-b", readers: EVERYONE });
    expect(flow.checkEgress({ universe, readers: only(["alice"]) })).toBe(
      "unresolved_input",
    );
  });

  it("blocks egress forever after unknown input", () => {
    const flow = new FlowState();
    flow.markUnknown();
    expect(flow.checkEgress({ universe, readers: only(["alice"]) })).toBe(
      "unresolved_input",
    );
  });

  it("refuses a destination in another universe", () => {
    const flow = new FlowState();
    flow.observe({ universe, readers: EVERYONE });
    expect(
      flow.checkEgress({ universe: "community-b", readers: EVERYONE }),
    ).toBe("destination_universe_mismatch");
  });
});
