import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineDoc,
  defineTask,
  defineTool,
  type Extension,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { Kind, nowSeconds, replyTags } from "../nostr/event.ts";
import { REPORT_TAG, RequestsDoc, ThreadDoc } from "../runtime/docs.ts";
import { assistantText, chunkText } from "../runtime/render.ts";
import { publishOnce } from "../service/publish.ts";
import { type AgentServices, mayUseWeb } from "./services.ts";

export type ResearchJob = {
  question: string;
  childId: number;
  reporterTaskId: number;
  status: "running" | "posted" | "failed" | "stopped";
  startedAt: number;
};

/** Research jobs started from a thread conversation. */
export const ResearchJobsDoc = defineDoc<{ jobs: Record<string, ResearchJob> }>(
  {
    kind: "keeper.research",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ jobs: {} }),
  },
);

/**
 * Owns a research conversation. It finishes at once; as a background task it
 * is a boundary, so the thread's ordinary idle waits and aborts never reach
 * the research, while `abort({ background: true })` still does.
 */
const ResearchAnchor = defineTask<null, { phase: "done" }, null>({
  name: "keeper.research-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
});

type ReporterInput = {
  readonly jobId: string;
  readonly childId: number;
  readonly question: string;
  readonly brief: string;
  /** Message the report replies to, and the person it notifies. */
  readonly replyTo: string | null;
  readonly requester: string | null;
};

type ReporterState =
  | { readonly phase: "research" }
  | {
      readonly phase: "post";
      readonly text: string;
      readonly status: "posted" | "failed" | "stopped";
    };

/** A worker's instructions; without the web, it researches what the team discussed in Buzz. */
function workerInstructions(web: boolean): string {
  return [
    "You are a research worker. Investigate the question thoroughly but efficiently.",
    web
      ? "Search the web, read the most relevant sources, and check what the team already discussed in Buzz with search_messages."
      : "You have no web access here, because this conversation is private. Research what the team already discussed in Buzz with search_messages and read_thread, and say what would need outside sources.",
    ...REPORT_FORMAT,
  ].join("\n");
}

const REPORT_FORMAT = [
  "Then write the final report in Markdown:",
  "**Summary**: one short paragraph that answers the question.",
  "**Findings**: bullets, each citing its sources as links.",
  "**Open questions**: what you could not establish.",
  "Stay under 700 words, and state only what your sources support.",
  "Your final message is posted to the team as the report, so do not address it to anyone in particular.",
];

export function researchExtension(
  services: AgentServices,
  workerExtensions: (domain: string) => readonly Extension[],
): Extension {
  const reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "keeper.research-reporter",
    version: 1,
    initial: () => ({ phase: "research" }),
    phases: {
      research: async (task, runtime, context) => {
        const child = await runtime.conversation(
          task.input.childId as ConversationId,
          context,
        );
        if (child === undefined) {
          const next = {
            phase: "post",
            text: "I couldn't start the research.",
            status: "failed",
          } as const;
          await runtime.commit(
            () => ({ status: "running", checkpoint: next }),
            context,
          );
          return;
        }
        // A rerun after a crash finds the same submission by its request id.
        const submission = await child.submit(
          {
            type: "input",
            content: task.input.brief,
            requestId: `research:${task.input.jobId}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          let next: ReporterState;
          if (settled.status === "done" && settled.type === "input") {
            // The answer is in the research conversation, which the task's own
            // conversation cannot see, so it is read from the table directly.
            const message = (await tx.entry(AssistantEntry, settled.answer))
              ?.model?.[0];
            const report =
              message?.role === "assistant"
                ? assistantText(message.content)
                : "";
            next = {
              phase: "post",
              text:
                report === ""
                  ? "The research finished without a written report."
                  : report,
              status: "posted",
            };
          } else if (
            settled.status === "unanswered" &&
            settled.reason === "aborted"
          ) {
            next = { phase: "post", text: "", status: "stopped" };
          } else {
            const reason =
              settled.status === "unanswered" ? settled.reason : "unknown";
            next = {
              phase: "post",
              text: `I couldn't finish the research (${reason}).`,
              status: "failed",
            };
          }
          return { status: "running", checkpoint: next };
        }, context);
      },
      post: async (task, runtime, context) => {
        const { text } = task.state.checkpoint;
        let { status } = task.state.checkpoint;
        const thread = await runtime.snapshot(
          ThreadDoc,
          runtime.conversationId,
          context,
        );
        if (text !== "" && thread !== undefined) {
          const heading =
            status === "posted"
              ? `📋 **Research report:** ${task.input.question}\n\n`
              : "";
          const parent = task.input.replyTo ?? thread.root;
          const outcome = await publishOnce(
            runtime,
            services.broker,
            {
              domain: thread.domain,
              channelId: thread.channelId,
              name: "report",
            },
            chunkText(`${heading}${text}`).map((part, index) => () => ({
              kind: Kind.StreamMessage,
              created_at: nowSeconds(),
              tags: [
                ["h", thread.channelId],
                ...(thread.root === null || parent === null
                  ? []
                  : replyTags(thread.root, parent)),
                ...(index === 0 && task.input.requester !== null
                  ? [["p", task.input.requester]]
                  : []),
                [REPORT_TAG, task.input.jobId],
              ],
              content: part,
            })),
            context,
          );
          if (!outcome.ok) {
            status = "failed";
            services.log.error("research report not delivered", {
              jobId: task.input.jobId,
              reason: outcome.reason,
            });
          }
        }
        await runtime.commit(async (tx) => {
          const job = (await tx.doc(ResearchJobsDoc, runtime.conversationId))
            .jobs[task.input.jobId];
          if (job !== undefined) job.status = status;
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const job = (await tx.doc(ResearchJobsDoc, runtime.conversationId))
          .jobs[task.input.jobId];
        if (job !== undefined) job.status = "stopped";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const research = defineTool({
    name: "research",
    description:
      "Start a background research job for a question that needs several sources or more than a minute of work. " +
      "The report is posted in this thread when it is ready, even hours later. After starting it, tell the person " +
      "briefly what you will look into; do not wait for the result.",
    parameters: Type.Object({
      question: Type.String({
        minLength: 5,
        description: "The research question, self-contained",
      }),
      brief: Type.Optional(
        Type.String({
          description:
            "Context from the conversation and what the report should focus on",
        }),
      ),
    }),
    // A rerun after a crash finds the job this call already started.
    replay: "safe",
    execute: async (args, api, context) => {
      const thread = await api.snapshot(ThreadDoc, api.conversationId, context);
      if (thread === undefined || thread.domain === "") {
        return {
          content: [{ type: "text", text: "Research needs a Buzz thread." }],
          isError: true,
        };
      }
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const requests = await api.snapshot(
        RequestsDoc,
        api.conversationId,
        context,
      );
      const inputs = new Set<number>(live?.run?.inputs ?? []);
      const request = Object.entries(requests?.items ?? {})
        .filter(([, item]) => inputs.has(item.submissionId))
        .sort(([, a], [, b]) => b.submissionId - a.submissionId)[0];
      const jobId = `job-${api.taskId}`;
      const brief = [
        `Question: ${args.question}`,
        args.brief === undefined ? "" : `Context and focus: ${args.brief}`,
      ]
        .filter((line) => line !== "")
        .join("\n\n");
      await api.commit(async (tx) => {
        const jobs = await tx.doc(ResearchJobsDoc, api.conversationId);
        if (jobs.jobs[jobId] !== undefined) return;
        const anchor = await tx.createTask(ResearchAnchor, null, {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        });
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: anchor },
        });
        await configure(tx, child.id, {
          ...(services.researchModel === undefined
            ? {}
            : { model: services.researchModel }),
          extensions: workerExtensions(thread.domain),
          instructions: workerInstructions(mayUseWeb(thread.domain)),
        });
        Object.assign(await tx.doc(ThreadDoc, child.id), thread);
        const reporterTaskId = await tx.createTask(
          reporter,
          {
            jobId,
            childId: child.id,
            question: args.question,
            brief,
            replyTo: request?.[0] ?? null,
            requester: request?.[1].author ?? null,
          },
          {
            ownership: { kind: "conversation" },
            conversationId: api.conversationId,
            background: true,
          },
        );
        jobs.jobs[jobId] = {
          question: args.question,
          childId: child.id,
          reporterTaskId,
          status: "running",
          startedAt: Date.now(),
        };
      }, context);
      return {
        content: [
          {
            type: "text",
            text: `Started research job ${jobId}. Its report will be posted in this thread when ready.`,
          },
        ],
      };
    },
  });

  return {
    name: "keeper.research",
    tools: [research],
    tasks: [ResearchAnchor, reporter],
  };
}
