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
