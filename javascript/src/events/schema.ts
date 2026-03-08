// THIS FILE IS SYNCED FROM langwatch-saas/langwatch/langwatch/src/app/api/scenario-events/[[...route]]/schemas/event-schemas.ts AND enums.ts
// DO NOT EDIT MANUALLY. Edit the backend source of truth and sync.
import { EventType, MessagesSnapshotEventSchema } from "@ag-ui/core";
import { z } from "zod";

/**
 * Verdict enum represents the possible outcomes of a test scenario
 */
export enum Verdict {
  SUCCESS = "success",
  FAILURE = "failure",
  INCONCLUSIVE = "inconclusive",
}

// Scenario event type enum
export enum ScenarioEventType {
  RUN_STARTED = "SCENARIO_RUN_STARTED",
  RUN_FINISHED = "SCENARIO_RUN_FINISHED",
  MESSAGE_SNAPSHOT = "SCENARIO_MESSAGE_SNAPSHOT",
  TEXT_MESSAGE_START = "SCENARIO_TEXT_MESSAGE_START",
  TEXT_MESSAGE_END = "SCENARIO_TEXT_MESSAGE_END",
  TEXT_MESSAGE_CONTENT = "SCENARIO_TEXT_MESSAGE_CONTENT",
  TOOL_CALL_START = "SCENARIO_TOOL_CALL_START",
  TOOL_CALL_ARGS = "SCENARIO_TOOL_CALL_ARGS",
  TOOL_CALL_END = "SCENARIO_TOOL_CALL_END",
}

export enum ScenarioRunStatus {
  SUCCESS = "SUCCESS",
  ERROR = "ERROR",
  CANCELLED = "CANCELLED",
  IN_PROGRESS = "IN_PROGRESS",
  PENDING = "PENDING",
  FAILED = "FAILED",
}

/**
 * AG-UI Base Event Schema
 * Provides the foundation for all events with type, timestamp, and raw event data
 */
const baseEventSchema = z.object({
  type: z.nativeEnum(EventType),
  timestamp: z.number(),
  rawEvent: z.any().optional(),
});

/**
 * Batch Run ID Schema
 */
export const batchRunIdSchema = z.string();

/**
 * Scenario Run ID Schema
 */
export const scenarioRunIdSchema = z.string();

/**
 * Scenario ID Schema
 */
export const scenarioIdSchema = z.string();

/**
 * Base Scenario Event Schema
 * Common fields shared by all scenario events including batch tracking and scenario identification.
 * Extends the base event schema with scenario-specific identifiers.
 */
const baseScenarioEventSchema = baseEventSchema.extend({
  batchRunId: batchRunIdSchema,
  scenarioId: scenarioIdSchema,
  scenarioRunId: scenarioRunIdSchema,
  scenarioSetId: z.string().optional().default("default"),
});

/**
 * Scenario Run Started Event Schema
 * Captures the initiation of a scenario run with metadata about the scenario being executed.
 * Contains the scenario name and optional description for identification purposes.
 */
export const scenarioRunStartedSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.RUN_STARTED),
  metadata: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
  }).catchall(z.unknown()),
});

/**
 * Scenario Results Schema
 * Defines the structure for scenario evaluation results including verdict and criteria analysis.
 * Matches the Python dataclass structure used in the evaluation system.
 */
export const scenarioResultsSchema = z.object({
  verdict: z.nativeEnum(Verdict),
  reasoning: z.string().optional(),
  metCriteria: z.array(z.string()),
  unmetCriteria: z.array(z.string()),
  error: z.string().optional(),
});
export type ScenarioResults = z.infer<typeof scenarioResultsSchema>;

/**
 * Scenario Run Finished Event Schema
 * Captures the completion of a scenario run with final status and evaluation results.
 * Status indicates success/failure, while results contain detailed evaluation outcomes.
 */
export const scenarioRunFinishedSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.RUN_FINISHED),
  status: z.nativeEnum(ScenarioRunStatus),
  results: scenarioResultsSchema.optional().nullable(),
});

/**
 * Scenario Message Snapshot Event Schema
 * Captures the conversation state at a specific point during scenario execution.
 * Includes searchable_content and payload for full message functionality.
 */
export const scenarioMessageSnapshotSchema = MessagesSnapshotEventSchema.merge(
  baseScenarioEventSchema.extend({
    type: z.literal(ScenarioEventType.MESSAGE_SNAPSHOT),
  }),
);

/**
 * Scenario Text Message Start Event Schema
 */
export const scenarioTextMessageStartSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: z.string(),
  messageIndex: z.number().optional(),
});

/**
 * Scenario Text Message End Event Schema
 */
export const scenarioTextMessageEndSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TEXT_MESSAGE_END),
  messageId: z.string(),
  role: z.string(),
  content: z.string().optional(),
  message: z.record(z.unknown()).optional(),
  traceId: z.string().optional(),
  messageIndex: z.number().optional(),
});

/**
 * Scenario Text Message Content Event Schema (broadcast only, streaming delta)
 */
export const scenarioTextMessageContentSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
});

/**
 * Scenario Tool Call Start Event Schema (broadcast only)
 */
export const scenarioToolCallStartSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TOOL_CALL_START),
  toolCallId: z.string(),
  toolCallName: z.string(),
  parentMessageId: z.string().optional(),
});

/**
 * Scenario Tool Call Args Event Schema (broadcast only)
 */
export const scenarioToolCallArgsSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
});

/**
 * Scenario Tool Call End Event Schema (broadcast only)
 */
export const scenarioToolCallEndSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.TOOL_CALL_END),
  toolCallId: z.string(),
});

/**
 * Scenario Event Union Schema
 * Discriminated union of all possible scenario event types.
 * Enables type-safe handling of different event types based on the 'type' field.
 */
export const scenarioEventSchema = z.discriminatedUnion("type", [
  scenarioRunStartedSchema,
  scenarioRunFinishedSchema,
  scenarioMessageSnapshotSchema,
  scenarioTextMessageStartSchema,
  scenarioTextMessageEndSchema,
  scenarioTextMessageContentSchema,
  scenarioToolCallStartSchema,
  scenarioToolCallArgsSchema,
  scenarioToolCallEndSchema,
]);

export type ScenarioRunStartedEvent = z.infer<typeof scenarioRunStartedSchema>;
export type ScenarioRunFinishedEvent = z.infer<
  typeof scenarioRunFinishedSchema
>;
export type ScenarioMessageSnapshotEvent = z.infer<
  typeof scenarioMessageSnapshotSchema
>;
export type ScenarioTextMessageStartEvent = z.infer<typeof scenarioTextMessageStartSchema>;
export type ScenarioTextMessageEndEvent = z.infer<typeof scenarioTextMessageEndSchema>;
export type ScenarioTextMessageContentEvent = z.infer<typeof scenarioTextMessageContentSchema>;
export type ScenarioToolCallStartEvent = z.infer<typeof scenarioToolCallStartSchema>;
export type ScenarioToolCallArgsEvent = z.infer<typeof scenarioToolCallArgsSchema>;
export type ScenarioToolCallEndEvent = z.infer<typeof scenarioToolCallEndSchema>;
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;

// Define response schemas
const successSchema = z.object({ success: z.boolean() });
const errorSchema = z.object({ error: z.string() });
const stateSchema = z.object({
  state: z.object({
    messages: z.array(z.any()),
    status: z.string(),
  }),
});
const runsSchema = z.object({ runs: z.array(z.string()) });
const eventsSchema = z.object({ events: z.array(scenarioEventSchema) });

export const responseSchemas = {
  success: successSchema,
  error: errorSchema,
  state: stateSchema,
  runs: runsSchema,
  events: eventsSchema,
};
