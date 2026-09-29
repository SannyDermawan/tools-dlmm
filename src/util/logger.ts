import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino, { type Logger } from "pino";

export type { Logger };

let root: Logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface LoggerOptions {
  level: string;
  logDir: string;
  frequency: "daily" | "hourly";
  size: string;
  keepFiles: number;
  /** Also write JSON lines to stdout. */
  stdout?: boolean;
}

/**
 * Structured JSON logging to a rotating file (pino-roll) and optionally stdout.
 * Secrets must never be passed in log objects; URLs go through redactUrl() first.
 */
export function initLogger(opts: LoggerOptions): Logger {
  const dir = resolve(opts.logDir);
  mkdirSync(dir, { recursive: true });
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-roll",
      level: opts.level,
      options: {
        file: resolve(dir, "dlmm"),
        extension: ".log",
        frequency: opts.frequency,
        size: opts.size,
        mkdir: true,
        dateFormat: "yyyy-MM-dd",
        limit: { count: opts.keepFiles },
      },
    },
  ];
  if (opts.stdout !== false) targets.push({ target: "pino/file", level: opts.level, options: { destination: 1 } });
  root = pino(
    {
      level: opts.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ["*.apiKey", "*.api_key", "*.secret", "*.privateKey"], censor: "***" },
    },
    pino.transport({ targets }),
  );
  return root;
}

export function logger(): Logger {
  return root;
}

export function child(bindings: Record<string, unknown>): Logger {
  return root.child(bindings);
}

/** Flush the transport before exit. */
export async function flushLogger(): Promise<void> {
  await new Promise<void>((res) => {
    try {
      root.flush(() => res());
    } catch {
      res();
    }
    setTimeout(res, 1000).unref();
  });
}
