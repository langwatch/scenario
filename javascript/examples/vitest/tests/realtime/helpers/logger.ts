/**
 * Centralized Logging Service
 *
 * Provides structured logging with configurable levels and context.
 * Separates logging concerns from business logic.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogContext {
  [key: string]: any;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  setLevel(level: LogLevel): void;
}

export interface LoggerConfig {
  level: LogLevel;
  prefix?: string;
  includeTimestamp?: boolean;
}

/**
 * Console-based logger implementation
 *
 * Provides structured logging with emojis and consistent formatting.
 * Can be easily replaced with other logging implementations.
 */
export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private prefix: string;
  private includeTimestamp: boolean;

  constructor(config: LoggerConfig = { level: LogLevel.INFO }) {
    this.level = config.level;
    this.prefix = config.prefix ?? "[Realtime]";
    this.includeTimestamp = config.includeTimestamp ?? false;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log("🐛", message, context, console.debug);
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.INFO) {
      this.log("ℹ️", message, context, console.log);
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.WARN) {
      this.log("⚠️", message, context, console.warn);
    }
  }

  error(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.ERROR) {
      this.log("❌", message, context, console.error);
    }
  }

  private log(
    emoji: string,
    message: string,
    context: LogContext | undefined,
    consoleMethod: (...args: any[]) => void
  ): void {
    const timestamp = this.includeTimestamp
      ? `[${new Date().toISOString()}] `
      : "";

    const prefix = `${timestamp}${this.prefix} ${emoji}`;

    if (context) {
      consoleMethod(`${prefix} ${message}`, context);
    } else {
      consoleMethod(`${prefix} ${message}`);
    }
  }
}

/**
 * No-op logger for production or when logging is disabled
 */
export class NoOpLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  setLevel(): void {}
}

/**
 * Creates a logger instance based on configuration
 *
 * @param config - Logger configuration
 * @returns Configured logger instance
 */
export function createLogger(config?: LoggerConfig): Logger {
  if (config?.level === LogLevel.NONE) {
    return new NoOpLogger();
  }

  return new ConsoleLogger(config);
}

/**
 * Default logger instance for convenience
 */
export const defaultLogger = createLogger();
