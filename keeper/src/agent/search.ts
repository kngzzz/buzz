import type { SearchProvider, SearchResult } from "./services.ts";

/** Brave Search API (https://api.search.brave.com). Requires a subscription token. */
export function braveSearch(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    name: "Brave Search",
    async search(
      query: string,
      count: number,
      signal?: AbortSignal,
    ): Promise<SearchResult[]> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok)
        throw new Error(`Brave Search returned HTTP ${response.status}`);
      const body = (await response.json()) as {
        web?: {
          results?: { title?: string; url?: string; description?: string }[];
        };
      };
      return (body.web?.results ?? []).flatMap((result) =>
        result.url === undefined
          ? []
          : [
              {
                title: result.title ?? result.url,
                url: result.url,
                snippet: stripTags(result.description ?? ""),
              },
            ],
      );
    },
  };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}
