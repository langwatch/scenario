import { getEnv } from "../config/env";
import { LogLevel, LOG_LEVELS } from "../config/log-levels";

/**
 * Simple logger that respects LOG_LEVEL environment variable.
 *
 * Supports standard log levels: error, warn, info, debug
 * Silent by default (good for library usage)
 */
export class Logger {
  /**
   * Creates a logger with context (e.g., class name)
   */
  static create(context: string): Logger {
    return new Logger(context);
  }

  constructor(private readonly context?: string) {}

  /**
   * Returns the current log level from environment.
   * Uses a getter for clarity and idiomatic usage.
   */
  private get LOG_LEVEL(): LogLevel {
    return getEnv().LOG_LEVEL;
  }

  /**
   * Returns the index of the given log level in the LOG_LEVELS array.
   * @param level - The log level to get the index for.
   * @returns The index of the log level in the LOG_LEVELS array.
   */
  private getLogLevelIndexFor(level: LogLevel): number {
    return LOG_LEVELS.indexOf(level);
  }

  /**
   * Checks if logging should occur based on LOG_LEVEL env var
   */
  private shouldLog(level: LogLevel): boolean {
    const currentLevelIndex = this.getLogLevelIndexFor(this.LOG_LEVEL);
    const requestedLevelIndex = this.getLogLevelIndexFor(level);

    // If LOG_LEVEL is not set or invalid, don't log (silent by default)
    return currentLevelIndex >= 0 && requestedLevelIndex <= currentLevelIndex;
  }

  private formatMessage(message: string): string {
    return this.context ? `[${this.context}] ${message}` : message;
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.error(formattedMessage, data);
      } else {
        console.error(formattedMessage);
      }
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.WARN)) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.warn(formattedMessage, data);
      } else {
        console.warn(formattedMessage);
      }
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.INFO)) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.info(formattedMessage, data);
      } else {
        console.info(formattedMessage);
      }
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.log(formattedMessage, data);
      } else {
        console.log(formattedMessage);
      }
    }
  }
}
