import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { Signer } from "./nostr/signer.ts";

/** Keeper's settings, read from the environment. */
export type KeeperConfig = {
  readonly relayUrl: string;
  readonly signer: Signer;
  readonly authTag: readonly string[] | undefined;
  readonly dataDir: string;
  readonly name: string;
  readonly about: string;
  /** `faux` runs a scripted model, for demos and tests without an API key. */
  readonly model: ModelRef | "faux";
  readonly researchModel: ModelRef | undefined;
  readonly braveApiKey: string | undefined;
  readonly allowedAgents: ReadonlySet<string>;
  readonly logLevel: "debug" | "info" | "warn" | "error";
};

export class ConfigError extends Error {}

export const CONFIG_HELP = `Keeper reads its settings from the environment:

  KEEPER_RELAY_URL           Relay WebSocket URL, e.g. ws://localhost:3000 (required)
  KEEPER_PRIVATE_KEY         Keeper's key, hex or nsec (or KEEPER_PRIVATE_KEY_FILE)
  KEEPER_MODEL               provider/model-id, e.g. anthropic/<model-id>, or "faux" (required)
  KEEPER_RESEARCH_MODEL      provider/model-id for research jobs (default: KEEPER_MODEL)
  KEEPER_DATA_DIR            Durable state directory (default: ./keeper-data)
  KEEPER_NAME                Display name (default: Keeper)
  KEEPER_ABOUT               Profile description shown to people
  KEEPER_AUTH_TAG            NIP-OA auth tag as JSON, when admitted through an owner
  KEEPER_ALLOWED_AGENTS      Comma-separated pubkeys of agents allowed to wake Keeper
  BRAVE_SEARCH_API_KEY       Enables the web_search tool
  KEEPER_LOG_LEVEL           debug | info | warn | error (default: info)

Provider credentials use pi-ai's usual variables, such as ANTHROPIC_API_KEY.`;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const relayUrl = required(env, "KEEPER_RELAY_URL");
  if (!/^wss?:\/\//.test(relayUrl))
    throw new ConfigError("KEEPER_RELAY_URL must start with ws:// or wss://");

  const keyFile = env.KEEPER_PRIVATE_KEY_FILE;
  const key =
    keyFile !== undefined
      ? readFileSync(keyFile, "utf8")
      : env.KEEPER_PRIVATE_KEY;
  if (key === undefined || key.trim() === "") {
    throw new ConfigError("set KEEPER_PRIVATE_KEY or KEEPER_PRIVATE_KEY_FILE");
  }
  let signer: Signer;
  try {
    signer = Signer.parse(key);
  } catch (error) {
    throw new ConfigError(`invalid private key: ${(error as Error).message}`);
  }

  const modelValue = required(env, "KEEPER_MODEL");
  const model =
    modelValue === "faux" ? "faux" : modelRef("KEEPER_MODEL", modelValue);
  const research = env.KEEPER_RESEARCH_MODEL;

  let authTag: readonly string[] | undefined;
  if (env.KEEPER_AUTH_TAG !== undefined && env.KEEPER_AUTH_TAG.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.KEEPER_AUTH_TAG);
    } catch {
      throw new ConfigError("KEEPER_AUTH_TAG is not valid JSON");
    }
    if (
      !Array.isArray(parsed) ||
      parsed[0] !== "auth" ||
      !parsed.every((part) => typeof part === "string")
    ) {
      throw new ConfigError(
        'KEEPER_AUTH_TAG must be a JSON array like ["auth", owner, conditions, sig]',
      );
    }
    authTag = parsed as string[];
  }

  const logLevel = env.KEEPER_LOG_LEVEL ?? "info";
  if (
    logLevel !== "debug" &&
    logLevel !== "info" &&
    logLevel !== "warn" &&
    logLevel !== "error"
  ) {
    throw new ConfigError(
      "KEEPER_LOG_LEVEL must be debug, info, warn or error",
    );
  }

  return {
    relayUrl,
    signer,
    authTag,
    dataDir: path.resolve(env.KEEPER_DATA_DIR ?? "keeper-data"),
    name: env.KEEPER_NAME ?? "Keeper",
    about:
      env.KEEPER_ABOUT ??
      "The workspace research assistant. Mention me in a thread with a question, or ask me to research something.",
    model,
    researchModel:
      research === undefined || research === "" || research === "faux"
        ? undefined
        : modelRef("KEEPER_RESEARCH_MODEL", research),
    braveApiKey: env.BRAVE_SEARCH_API_KEY || undefined,
    allowedAgents: new Set(
      (env.KEEPER_ALLOWED_AGENTS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== ""),
    ),
    logLevel,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new ConfigError(`${name} is required`);
  return value.trim();
}

function modelRef(name: string, value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new ConfigError(`${name} must look like provider/model-id`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
