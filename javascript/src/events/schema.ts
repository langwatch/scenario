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
  }),
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
  })
);

/**
 * Scenario Event Union Schema
 * Discriminated union of all possible scenario event types.
 * Enables type-safe handling of different event types based on the 'type' field.
 */
export const scenarioEventSchema = z.discriminatedUnion("type", [
  scenarioRunStartedSchema,
  scenarioRunFinishedSchema,
  scenarioMessageSnapshotSchema,
]);

export type ScenarioRunStartedEvent = z.infer<typeof scenarioRunStartedSchema>;
export type ScenarioRunFinishedEvent = z.infer<typeof scenarioRunFinishedSchema>;
export type ScenarioMessageSnapshotEvent = z.infer<typeof scenarioMessageSnapshotSchema>;
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
