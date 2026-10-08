import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** Directory to write log files into. Defaults to "logs". */
  dir?: string;
  /** Minimum level to emit. Defaults to "info". */
  level?: LogLevel;
  /** Also echo to the console. Defaults to true. */
  console?: boolean;
}

/**
 * Minimal structured logger. Writes newline-delimited JSON to a daily file
 * (logs/toprr-YYYY-MM-DD.log) and optionally echoes a human line to stderr.
 *
 * File writes are best-effort and never throw into the caller — logging must
 * not break the feed/sync flow.
 */
export class Logger {
  private readonly dir: string;
  private readonly minLevel: number;
  private readonly echo: boolean;
  private dirReady = false;

  constructor(options: LoggerOptions = {}) {
    this.dir = options.dir ?? process.env.LOG_DIR ?? "logs";
    this.minLevel = LEVEL_ORDER[options.level ?? "info"];
    this.echo = options.console ?? true;
  }

  private filePath(): string {
    const day = new Date().toISOString().slice(0, 10);
    return join(this.dir, `toprr-${day}.log`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    try {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    } catch {
      // Leave dirReady false; file write will be skipped below.
    }
  }

  async log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };

    if (this.echo) {
      const line = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
      const stream = level === "error" || level === "warn" ? console.error : console.error;
      stream(meta ? `${line} ${JSON.stringify(meta)}` : line);
    }

    await this.ensureDir();
    if (this.dirReady) {
      try {
        await appendFile(this.filePath(), JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // Best-effort; swallow file errors.
      }
    }
  }

  debug(message: string, meta?: Record<string, unknown>) {
    return this.log("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>) {
    return this.log("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>) {
    return this.log("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>) {
    return this.log("error", message, meta);
  }
}

/** Shared default logger instance. */
export const logger = new Logger();
