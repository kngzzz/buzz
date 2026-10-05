import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FAUX_MODEL, fauxBrain } from "./agent/faux-brain.ts";
import { braveSearch } from "./agent/search.ts";
import { CONFIG_HELP, ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { Keeper } from "./service/keeper.ts";

/** `node src/main.ts`: run Keeper against one community's relay until interrupted. */
async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${CONFIG_HELP}\n`);
    return;
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`keeper: ${error.message}\n\n${CONFIG_HELP}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const log = createLogger(config.logLevel);
  const models = builtinModels();
  if (config.model === "faux") models.setProvider(fauxBrain().provider);

  const keeper = await Keeper.start({
    relayUrl: config.relayUrl,
    signer: config.signer,
    ...(config.authTag === undefined ? {} : { authTag: config.authTag }),
    dataDir: config.dataDir,
    name: config.name,
    about: config.about,
    models,
    model: config.model === "faux" ? FAUX_MODEL : config.model,
    ...(config.researchModel === undefined
      ? {}
      : { researchModel: config.researchModel }),
    ...(config.braveApiKey === undefined
      ? {}
      : { search: braveSearch(config.braveApiKey) }),
    allowedAgents: config.allowedAgents,
    log,
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    keeper.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("shutdown failed", { error: String(error) });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `keeper: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
