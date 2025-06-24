import { env, LogLevel } from "../config";

/**
 * Simple logger that respects SCENARIO_LOG_LEVEL environment variable.
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

  private getLogLevel(): LogLevel {
    return env.SCENARIO_LOG_LEVEL ?? LogLevel.INFO;
  }

  private getLogLevelIndex(level: LogLevel): number {
    return Object.values(LogLevel).indexOf(level);
  }

  /**
   * Checks if logging should occur based on LOG_LEVEL env var
   */
  private shouldLog(level: LogLevel): boolean {
    const currentLevelIndex = this.getLogLevelIndex(this.getLogLevel());
    const requestedLevelIndex = this.getLogLevelIndex(level);

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
