/**
 * Minimal logger for the Twilio adapter. Mirrors the Python parity's
 * `logger = logging.getLogger("scenario.voice.twilio")` so production-ops
 * signals (rejected webhooks, invalid signatures, DTMF receipt, disconnect)
 * surface at runtime instead of being silently dropped.
 *
 * Stays inside the adapter module on purpose — a real shared-logger module
 * lands in its own PR (see PR #539 "New Issue" follow-up). For now, a thin
 * console wrapper with a stable `[twilio]` prefix is enough to match the
 * Python log-site coverage and is easy to swap out later.
 */

export type LogLevel = "debug" | "info" | "warn";

export interface VoiceLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

function format(message: string, fields?: Record<string, unknown>): string {
  if (!fields) return `[twilio] ${message}`;
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  return `[twilio] ${message} ${pairs}`;
}

export const twilioLogger: VoiceLogger = {
  debug(message, fields) {
     
    console.debug(format(message, fields));
  },
  info(message, fields) {
     
    console.info(format(message, fields));
  },
  warn(message, fields) {
     
    console.warn(format(message, fields));
  },
};
