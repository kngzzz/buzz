import type { ModelRef } from "@earendil-works/pi-durable";
import type { Broker } from "../broker/broker.ts";
import type { Directory } from "../broker/directory.ts";
import type { Logger } from "../log.ts";
import type { SafeFetchResult } from "../net/safe-fetch.ts";

export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

/** A web search backend; Keeper offers `web_search` only when one is configured. */
export type SearchProvider = {
  readonly name: string;
  search(
    query: string,
    count: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;
};

/** Trusted services the tools close over. The model reaches them only through tool calls. */
export type AgentServices = {
  readonly name: string;
  readonly broker: Broker;
  readonly directory: Directory;
  readonly researchModel: ModelRef | undefined;
  readonly search: SearchProvider | undefined;
  readonly fetchPage: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<SafeFetchResult>;
  readonly log: Logger;
};

/**
 * Whether a domain's conversations may reach the open web. Only the `public`
 * domain may: a search query or a fetched URL written in a private channel or
 * DM is private too (spec §9.6, §11.2), and nothing past the broker checks it.
 */
export function mayUseWeb(domain: string): boolean {
  return domain === "public";
}
