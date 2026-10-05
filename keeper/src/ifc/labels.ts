/**
 * Reader-set confidentiality labels, ported from `crates/ifc-core`.
 *
 * Information may flow from `source` to `destination` only when the
 * destination adds no readers. Combining inputs intersects their reader sets.
 * `test/fixtures/reader-sets.json` pins the same cases the Rust crate tests.
 */

export type ReaderSet =
  | { readonly kind: "everyone" }
  | { readonly kind: "only"; readonly readers: ReadonlySet<string> };

export const EVERYONE: ReaderSet = { kind: "everyone" };

export function only(readers: Iterable<string>): ReaderSet {
  return { kind: "only", readers: new Set(readers) };
}

/** Whether information readable by `source` may flow to `destination`. */
export function canFlowTo(source: ReaderSet, destination: ReaderSet): boolean {
  if (source.kind === "everyone") return true;
  if (destination.kind === "everyone") return false;
  for (const reader of destination.readers) {
    if (!source.readers.has(reader)) return false;
  }
  return true;
}

/** Combine two inputs: only principals allowed to read both may read the result. */
export function join(left: ReaderSet, right: ReaderSet): ReaderSet {
  if (left.kind === "everyone") return right;
  if (right.kind === "everyone") return left;
  return only([...left.readers].filter((reader) => right.readers.has(reader)));
}

/** The greatest label that can flow to both inputs. */
export function meet(left: ReaderSet, right: ReaderSet): ReaderSet {
  if (left.kind === "everyone" || right.kind === "everyone") return EVERYONE;
  return only([...left.readers, ...right.readers]);
}

/** A reader set inside one universe; in Buzz a universe is one community. */
export type Label = {
  readonly universe: string;
  readonly readers: ReaderSet;
};

export type EgressError =
  | "unresolved_input"
  | "destination_universe_mismatch"
  | "destination_widens_readers";

/**
 * Monotonic confidentiality state of one computation, such as one
 * conversation. Every admitted label is joined in; unknown or cross-universe
 * input permanently blocks ordinary egress.
 */
export class FlowState {
  #accumulated: Label | undefined;
  #unresolved = false;

  observe(label: Label): void {
    const current = this.#accumulated;
    if (current === undefined) {
      this.#accumulated = label;
      return;
    }
    if (current.universe !== label.universe) {
      this.#unresolved = true;
      return;
    }
    this.#accumulated = {
      universe: current.universe,
      readers: join(current.readers, label.readers),
    };
  }

  markUnknown(): void {
    this.#unresolved = true;
  }

  checkEgress(destination: Label): EgressError | undefined {
    if (this.#unresolved) return "unresolved_input";
    const current = this.#accumulated;
    if (current === undefined) return undefined;
    if (current.universe !== destination.universe) {
      return "destination_universe_mismatch";
    }
    if (!canFlowTo(current.readers, destination.readers)) {
      return "destination_widens_readers";
    }
    return undefined;
  }

  get accumulated(): Label | undefined {
    return this.#accumulated;
  }
}
