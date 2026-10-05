/** Minimal structured logger: one JSON object per line on stderr. */
export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(
  minimum: Level = "info",
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit =
    (level: Level) => (message: string, fields?: Record<string, unknown>) => {
      if (ORDER[level] < ORDER[minimum]) return;
      write(
        JSON.stringify({
          at: new Date().toISOString(),
          level,
          message,
          ...fields,
        }),
      );
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
