/**
 * Log levels supported by the scenario package.
 *
 * - ERROR: Critical errors that require immediate attention.
 * - WARN: Warnings about potentially problematic situations.
 * - INFO: Informational messages about normal operations.
 * - DEBUG: Detailed debugging information for development.
 */
export enum LogLevel {
  ERROR = "ERROR",
  WARN = "WARN",
  INFO = "INFO",
  DEBUG = "DEBUG",
}

/**
 * Ordered array version of log levels from the LogLevel enum.
 * Used for log level comparison and filtering.
 */
export const LOG_LEVELS: LogLevel[] = Object.values(LogLevel);
