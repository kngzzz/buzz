import {
  AssistantEntry,
  type ConversationId,
  defineTask,
} from "@earendil-works/pi-durable";
import type { Broker } from "../broker/broker.ts";
import { Kind, nowSeconds, replyTags } from "../nostr/event.ts";
import { AnswersDoc, ThreadDoc } from "../runtime/docs.ts";
import { assistantText, chunkText } from "../runtime/render.ts";
import { publishOnce } from "./publish.ts";

export type ReplyInput = {
  /** The Buzz event the request came from; also the submission's `requestId`. */
  readonly requestId: string;
  readonly author: string;
  /** The submitted input, needed only to reacquire the submission by `requestId`. */
  readonly content: string;
};

type ReplyState =
  | { readonly phase: "wait" }
  | { readonly phase: "post"; readonly text: string };

/**
 * One durable task per request: wait for the answer, then post it into the
 * thread exactly once. Background, so `stop` in the thread never strands a
 * reply, and pi-durable resumes it after a crash in whichever phase it was.
 */
export function defineReplyTask(broker: Broker) {
  return defineTask<ReplyInput, ReplyState, null>({
    name: "keeper.reply",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const conversation = await runtime.conversation(
          runtime.conversationId,
          context,
        );
        if (conversation === undefined)
          throw new Error("reply task lost its conversation");
        // Same requestId: this returns the original submission without writing anything.
        const submission = await conversation.submit(
          {
            type: "input",
            content: task.input.content,
            requestId: task.input.requestId,
          },
          context,
        );
        const settled = await submission.wait(context);
        let text = "";
        if (settled.status === "done" && settled.type === "input") {
          const answer = settled.answer;
          const entry = await runtime.entry(AssistantEntry, answer, context);
          const message = entry?.model?.[0];
          const body =
            message?.role === "assistant" ? assistantText(message.content) : "";
          await runtime.commit(async (tx) => {
            const answers = await tx.doc(AnswersDoc, runtime.conversationId);
            const claim = answers.claims[String(answer)];
            if (claim === undefined)
              answers.claims[String(answer)] = runtime.taskId;
            // A steered input settled with an answer another reply task already claimed.
            text =
              claim === undefined || claim === runtime.taskId
                ? body || "Done."
                : "";
            return { status: "running", checkpoint: { phase: "post", text } };
          }, context);
          return;
        }
        if (settled.status === "unanswered" && settled.reason !== "aborted") {
          text = `I couldn't finish that (${settled.reason}). You can ask again.`;
        }
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "post", text } }),
          context,
        );
      },
      post: async (task, runtime, context) => {
        const { text } = task.state.checkpoint;
        if (text !== "") {
          const thread = await runtime.snapshot(
            ThreadDoc,
            runtime.conversationId as ConversationId,
            context,
          );
          if (thread === undefined) throw new Error("reply task has no thread");
          const parts = chunkText(text);
          await publishOnce(
            runtime,
            broker,
            {
              domain: thread.domain,
              channelId: thread.channelId,
              name: "reply",
            },
            parts.map((part, index) => () => ({
              kind: Kind.StreamMessage,
              created_at: nowSeconds(),
              tags: [
                ["h", thread.channelId],
                ...(thread.root === null
                  ? []
                  : replyTags(thread.root, task.input.requestId)),
                ...(index === 0 ? [["p", task.input.author]] : []),
              ],
              content: part,
            })),
            context,
          );
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
}
