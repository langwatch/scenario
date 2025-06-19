/**
 * Simple logger that respects LOG_LEVEL environment variable.
 *
 * Supports standard log levels: error, warn, info, debug
 * Silent by default (good for library usage)
 */
export class Logger {
  constructor(private readonly context?: string) {}

  /**
   * Creates a logger with context (e.g., class name)
   */
  static create(context: string): Logger {
    return new Logger(context);
  }

  /**
   * Checks if logging should occur based on LOG_LEVEL env var
   */
  private shouldLog(level: "error" | "warn" | "info" | "debug"): boolean {
    const logLevel = (process.env.LOG_LEVEL || "").toLowerCase();

    const levels = ["error", "warn", "info", "debug"];
    const currentLevelIndex = levels.indexOf(logLevel);
    const requestedLevelIndex = levels.indexOf(level);

    // If LOG_LEVEL is not set or invalid, don't log (silent by default)
    return currentLevelIndex >= 0 && requestedLevelIndex <= currentLevelIndex;
  }

  private formatMessage(message: string): string {
    return this.context ? `[${this.context}] ${message}` : message;
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog("error")) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.error(formattedMessage, data);
      } else {
        console.error(formattedMessage);
      }
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog("warn")) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.warn(formattedMessage, data);
      } else {
        console.warn(formattedMessage);
      }
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog("info")) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.info(formattedMessage, data);
      } else {
        console.info(formattedMessage);
      }
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog("debug")) {
      const formattedMessage = this.formatMessage(message);
      if (data) {
        console.log(formattedMessage, data);
      } else {
        console.log(formattedMessage);
      }
    }
  }
}
