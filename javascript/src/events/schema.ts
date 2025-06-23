import { EventType, MessagesSnapshotEventSchema } from "@ag-ui/core";
import { z } from "zod";

/**
 * The verdict of a scenario run.
 */
export enum Verdict {
  /**
   * The scenario completed successfully.
   */
  SUCCESS = "success",
  /**
   * The scenario failed.
   */
  FAILURE = "failure",
  /**
   * The scenario is inconclusive.
   */
  INCONCLUSIVE = "inconclusive",
}

/**
 * The type of a scenario event.
 */
export enum ScenarioEventType {
  /**
   * A scenario run has started.
   */
  RUN_STARTED = "SCENARIO_RUN_STARTED",
  /**
   * A scenario run has finished.
   */
  RUN_FINISHED = "SCENARIO_RUN_FINISHED",
  /**
   * A snapshot of the messages in a scenario.
   */
  MESSAGE_SNAPSHOT = "SCENARIO_MESSAGE_SNAPSHOT",
}

/**
 * The status of a scenario run.
 */
export enum ScenarioRunStatus {
  /**
   * The scenario completed successfully.
   */
  SUCCESS = "SUCCESS",
  /**
   * The scenario failed with an error.
   */
  ERROR = "ERROR",
  /**
   * The scenario was cancelled.
   */
  CANCELLED = "CANCELLED",
  /**
   * The scenario is in progress.
   */
  IN_PROGRESS = "IN_PROGRESS",
  /**
   * The scenario is pending execution.
   */
  PENDING = "PENDING",
  /**
   * The scenario failed.
   */
  FAILED = "FAILED",
}

// AG-UI Base Event Schema
const baseEventSchema = z.object({
  type: z.nativeEnum(EventType),
  timestamp: z.number().optional(),
  rawEvent: z.any().optional(),
});

// Base scenario event schema with common fields
const baseScenarioEventSchema = baseEventSchema.extend({
  batchRunId: z.string(),
  scenarioId: z.string(),
  scenarioRunId: z.string(),
});

// Scenario Run Started Event
// TODO: Consider metadata
export const scenarioRunStartedSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.RUN_STARTED),
  metadata: z.object({
    name: z.string(),
    description: z.string().optional(),
    // config: z.record(z.unknown()).optional(),
  }),
});

// Scenario Run Finished Event
// TODO: Consider error, metrics
export const scenarioRunFinishedSchema = baseScenarioEventSchema.extend({
  type: z.literal(ScenarioEventType.RUN_FINISHED),
  status: z.nativeEnum(ScenarioRunStatus),
  results: z
    .object({
      verdict: z.nativeEnum(Verdict),
      reasoning: z.string().optional(),
      metCriteria: z.array(z.string()),
      unmetCriteria: z.array(z.string()),
      error: z.string().optional(),
    })
    .nullable(),
});

// Scenario Message Snapshot Event
export const scenarioMessageSnapshotSchema = MessagesSnapshotEventSchema.merge(
  baseScenarioEventSchema.extend({
    type: z.literal(ScenarioEventType.MESSAGE_SNAPSHOT),
  })
);

// Union type for all scenario events
export const scenarioEventSchema = z.discriminatedUnion("type", [
  scenarioRunStartedSchema,
  scenarioRunFinishedSchema,
  scenarioMessageSnapshotSchema,
]);

// Type exports
/**
 * Event fired when a scenario run starts.
 */
export type ScenarioRunStartedEvent = z.infer<typeof scenarioRunStartedSchema>;
/**
 * Event fired when a scenario run finishes.
 */
export type ScenarioRunFinishedEvent = z.infer<
  typeof scenarioRunFinishedSchema
>;
/**
 * Event fired to snapshot the current messages in a scenario.
 */
export type ScenarioMessageSnapshotEvent = z.infer<
  typeof scenarioMessageSnapshotSchema
>;
/**
 * A union of all possible scenario events.
 */
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
