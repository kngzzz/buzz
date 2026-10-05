import {
  createRegistry,
  defineExtension,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import type { Broker } from "../broker/broker.ts";
import { defineReplyTask } from "../service/reply-task.ts";
import { threadSections } from "./prompt.ts";
import { researchExtension } from "./research.ts";
import type { AgentServices } from "./services.ts";
import { buzzTools, webTools } from "./tools.ts";

export type KeeperAgent = {
  readonly registry: Registry;
  /** What a thread or DM conversation runs with by default. */
  readonly threadExtensions: readonly Extension[];
  readonly replyTask: ReturnType<typeof defineReplyTask>;
};

/**
 * Keeper's capabilities as pi-durable extensions, so each can be selected per
 * conversation and reloaded in place:
 *
 * - `keeper.core`     prompt sections for thread conversations
 * - `keeper.read`     Buzz reads through the broker
 * - `keeper.web`      web fetch, and search when a provider is configured
 * - `keeper.research` the research tool and its durable tasks
 * - `keeper.replies`  the reply task that posts answers exactly once
 *
 * Research workers select only `keeper.read` and `keeper.web`, so a worker
 * cannot start research of its own.
 */
export function buildAgent(
  services: AgentServices,
  broker: Broker,
): KeeperAgent {
  const core = defineExtension({
    name: "keeper.core",
    sections: threadSections(services),
  });
  const read = defineExtension({
    name: "keeper.read",
    tools: buzzTools(services),
  });
  const web = defineExtension({
    name: "keeper.web",
    tools: webTools(services),
  });
  const research = researchExtension(services, () => [read, web]);
  const replyTask = defineReplyTask(broker);
  const replies = defineExtension({
    name: "keeper.replies",
    tasks: [replyTask],
  });

  const registry = createRegistry();
  for (const extension of [core, read, web, research, replies])
    registry.install(extension);
  return { registry, threadExtensions: [core, read, web, research], replyTask };
}
