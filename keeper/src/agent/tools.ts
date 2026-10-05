import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { BrokerRefusal } from "../broker/broker.ts";
import { FetchRefused, htmlToText } from "../net/safe-fetch.ts";
import { channelOf, type NostrEvent } from "../nostr/event.ts";
import { ThreadDoc } from "../runtime/docs.ts";
import { type AgentServices, mayUseWeb } from "./services.ts";

const text = (value: string, isError = false): ToolExecutionResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

/** Deep link a person can open in Buzz. */
export function messageLink(event: Pick<NostrEvent, "id" | "tags">): string {
  return `buzz://message?channel=${channelOf(event) ?? ""}&id=${event.id}`;
}

async function formatMessages(
  events: readonly NostrEvent[],
  services: AgentServices,
): Promise<string> {
  const lines: string[] = [];
  for (const event of events) {
    const name = await services.broker.displayName(event.pubkey);
    const at = new Date(event.created_at * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const channel =
      services.directory.get(channelOf(event) ?? "")?.name ?? "unknown";
    lines.push(
      `- [${at}] ${name} in #${channel} (${messageLink(event)}):\n  ${event.content.replace(/\n/g, "\n  ")}`,
    );
  }
  return lines.join("\n");
}

/** Read and search tools for Buzz content. Every read passes the broker's audience check. */
export function buzzTools(services: AgentServices) {
  const readThread = defineTool({
    name: "read_thread",
    description:
      "Read the messages of the current Buzz thread (or DM), oldest first, with authors and links. " +
      "Use it when you need more of the discussion than you were shown.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 500,
          description: "Most recent messages to return",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const thread = await api.snapshot(ThreadDoc, api.conversationId, context);
      if (thread === undefined || thread.channelId === "")
        return text("This conversation has no Buzz thread.", true);
      try {
        const events = await services.broker.channelRead(thread.domain, {
          channelId: thread.channelId,
          ...(thread.root === null ? {} : { rootEventId: thread.root }),
          limit: args.limit ?? 200,
        });
        return text(
          events.length === 0
            ? "No messages."
            : await formatMessages(
                events.slice(-(args.limit ?? 200)),
                services,
              ),
        );
      } catch (error) {
        return text(
          error instanceof BrokerRefusal
            ? error.message
            : `Could not read the thread: ${String(error)}`,
          true,
        );
      }
    },
  });

  const searchMessages = defineTool({
    name: "search_messages",
    description:
      "Full-text search of Buzz messages in the channels this conversation may read. " +
      "Returns matches with author, channel and a link. Use it to find what the team already discussed.",
    parameters: Type.Object({
      query: Type.String({ minLength: 2, description: "Words to search for" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const thread = await api.snapshot(ThreadDoc, api.conversationId, context);
      if (thread === undefined || thread.domain === "")
        return text("This conversation has no Buzz audience.", true);
      try {
        const hits = await services.broker.search(
          thread.domain,
          args.query,
          args.limit ?? 20,
        );
        return text(
          hits.length === 0
            ? "No matches you may see from here."
            : await formatMessages(hits, services),
        );
      } catch (error) {
        return text(`Search failed: ${String(error)}`, true);
      }
    },
  });

  return [readThread, searchMessages];
}

/**
 * Whether this conversation may use the web. Only the public domain's
 * conversations are offered web tools; this check backs that up, so a
 * misconfigured extension list cannot open a private conversation to the web.
 */
async function webAllowed(
  api: ToolExecutionApi,
  context: Context,
): Promise<boolean> {
  const thread = await api.snapshot(ThreadDoc, api.conversationId, context);
  return thread !== undefined && mayUseWeb(thread.domain);
}

const WEB_OFF = "Web access is off in private conversations.";

/** Web tools: fetch is always available; search needs a configured provider. */
export function webTools(services: AgentServices) {
  const webFetch = defineTool({
    name: "web_fetch",
    description:
      "Fetch a public web page and return its readable text. Only http(s) URLs on public addresses are allowed.",
    parameters: Type.Object({
      url: Type.String({ description: "The page URL" }),
      maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 50_000 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (!(await webAllowed(api, context))) return text(WEB_OFF, true);
      try {
        const page = await services.fetchPage(args.url, context.abortSignal);
        if (page.status >= 400)
          return text(`The page returned HTTP ${page.status}.`, true);
        const html = /html/i.test(page.contentType);
        const extracted = html
          ? htmlToText(page.body)
          : { title: "", text: page.body };
        const limit = args.maxChars ?? 20_000;
        const body =
          extracted.text.length > limit
            ? `${extracted.text.slice(0, limit)}\n…(truncated)`
            : extracted.text;
        return text(
          `URL: ${page.url}\n${extracted.title === "" ? "" : `Title: ${extracted.title}\n`}\n${body}`,
        );
      } catch (error) {
        return text(
          error instanceof FetchRefused
            ? `Refused: ${error.message}`
            : `Fetch failed: ${String(error)}`,
          true,
        );
      }
    },
  });

  const search = services.search;
  if (search === undefined) return [webFetch];

  const webSearch = defineTool({
    name: "web_search",
    description: `Search the public web (${search.name}). Returns titles, URLs and snippets; fetch pages to read them.`,
    parameters: Type.Object({
      query: Type.String({ minLength: 2 }),
      count: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (!(await webAllowed(api, context))) return text(WEB_OFF, true);
      try {
        const results = await search.search(
          args.query,
          args.count ?? 8,
          context.abortSignal,
        );
        if (results.length === 0) return text("No results.");
        return text(
          results
            .map(
              (result, index) =>
                `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
            )
            .join("\n"),
        );
      } catch (error) {
        return text(`Search failed: ${String(error)}`, true);
      }
    },
  });

  return [webFetch, webSearch];
}
