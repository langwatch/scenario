/**
 * AI SDK 7 emits no spans until a telemetry integration is registered.
 * Loaded once per worker as a vitest setup file.
 */
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

registerTelemetry(new OpenTelemetry());
