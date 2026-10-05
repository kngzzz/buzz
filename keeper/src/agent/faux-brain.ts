import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";

export const FAUX_MODEL: ModelRef = {
  provider: "faux",
  modelId: "keeper-demo",
};

/**
 * A scripted stand-in for a model, for demos and tests without an API key. It
 * reads the real transcript and makes real tool calls, so everything around
 * the model — durability, tools, research jobs, replies — runs for real:
 *
 * - "research …" starts a research job;
 * - "summarize" or "decide" reads the thread and counts what it found;
 * - anything else gets an echo naming the person who asked and counting the
 *   earlier messages in its context, which shows that thread context arrives.
 */
export function fauxBrain(): FauxProviderHandle {
  const faux = fauxProvider({
    provider: FAUX_MODEL.provider,
    models: [
      { id: FAUX_MODEL.modelId, contextWindow: 200_000, maxTokens: 8_000 },
    ],
  });
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]); // stay ready for the next request
    return isWorker(context.messages)
      ? workerTurn(context.messages)
      : threadTurn(context.messages);
  };
  faux.setResponses([respond]);
  return faux;
}

function threadTurn(messages: readonly Message[]): AssistantMessage {
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    if (last.toolName === "research") {
      return fauxAssistantMessage(
        "On it — I started a research job and will post the report in this thread when it's ready.",
      );
    }
    if (last.toolName === "read_thread") {
      const text = textOf(last.content);
      const count = (text.match(/^- \[/gm) ?? []).length;
      const people = [
        ...new Set(
          [...text.matchAll(/^- \[[^\]]+\] (.+?) in #/gm)].map(
            (match) => match[1],
          ),
        ),
      ];
      return fauxAssistantMessage(
        `I read this thread: ${count} message${count === 1 ? "" : "s"} from ${people.join(", ") || "nobody yet"}. ` +
          "(Demo mode: a real model would summarize the decisions and owners here.)",
      );
    }
    return fauxAssistantMessage("Done.");
  }
  const request = latestRequest(messages);
  if (/\bresearch\b/i.test(request.text)) {
    const question =
      request.text.replace(/^.*?\bresearch\b[:\s]*/i, "").trim() ||
      request.text;
    return toolCall("research", { question });
  }
  if (/summar|decide/i.test(request.text)) return toolCall("read_thread", {});
  const earlier =
    messages.filter((message) => message.role === "user").length - 1;
  return fauxAssistantMessage(
    `Hi ${request.from}! (Demo mode) You said: “${request.text}”. ` +
      `I can see ${earlier} earlier message${earlier === 1 ? "" : "s"} in this conversation.`,
  );
}

function workerTurn(messages: readonly Message[]): AssistantMessage {
  const question =
    /Question: (.+)/.exec(textOfUser(messages))?.[1]?.trim() ?? "the question";
  const results = messages.filter((message) => message.role === "toolResult");
  if (results.length === 0) {
    const tools = offeredTools(messages);
    if (tools.has("web_search"))
      return toolCall("web_search", { query: question });
    return toolCall("search_messages", {
      query: question.split(/\s+/)[0] ?? question,
    });
  }
  const evidence = results
    .map((result) => textOf(result.content).split("\n")[0])
    .join("; ");
  return fauxAssistantMessage(
    [
      `**Summary**\nDemo report for: ${question}.`,
      `**Findings**\n- First result: ${evidence || "nothing found"}`,
      "**Open questions**\n- Written in demo mode, without a model.",
    ].join("\n\n"),
  );
}

function toolCall(
  name: string,
  args: Record<string, string>,
): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: "toolUse",
  });
}

function isWorker(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "system" &&
      Object.values(message.sections ?? {}).some(
        (text) => text?.includes("research worker") === true,
      ),
  );
}

function offeredTools(messages: readonly Message[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? [])
      names.delete(removed.name);
    for (const added of message.toolsAdded ?? []) names.add(added.name);
  }
  return names;
}

function latestRequest(messages: readonly Message[]): {
  from: string;
  text: string;
} {
  const raw = textOfUser(messages);
  const envelope =
    /<message from="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/message>/.exec(raw);
  return envelope === null
    ? { from: "there", text: raw.trim() }
    : {
        from: envelope[1] ?? "there",
        text: (envelope[2] ?? "").replace(/^@\S+\s*/, "").trim(),
      };
}

function textOfUser(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : textOf(message.content);
    }
  }
  return "";
}

function textOf(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    )
    .join("");
}
