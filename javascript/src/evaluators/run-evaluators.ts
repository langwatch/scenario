/**
 * Runs the evaluators attached to a scenario once the run has a verdict, and
 * applies their results to the run: a required evaluator that fails fails
 * the scenario, a score only reports.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type {
  EvaluationResult,
  EvaluatorMapping,
  ScenarioEvaluator,
  ScenarioResult,
} from "../domain";
import type { EvaluateApiResponse, EvaluatorSpec } from "./evaluations-api";
import { inferEvaluatorMappings } from "./inference";
import {
  displayValue,
  readsTrace,
  resolveInput,
  type EvaluatorInputContext,
  type ResolvedInput,
} from "./resolve-inputs";
import { Logger } from "../utils/logger";

/** The largest `inputs` value an evaluation result carries. */
export const EVALUATION_INPUT_MAX_CHARS = 2000;

/** What the runner needs from the run and from LangWatch. */
export interface RunEvaluatorsDeps {
  getEvaluatorSpec: (evaluatorRef: string) => Promise<EvaluatorSpec | undefined>;
  evaluate: (args: {
    evaluatorRef: string;
    data: Record<string, unknown>;
    settings?: Record<string, unknown>;
    traceId?: string;
  }) => Promise<EvaluateApiResponse>;
  /** Spans of the run collected so far, local and remote. */
  getSpans: () => ReadableSpan[];
  /**
   * Fetches the remote traces of the run into the span collector, waiting
   * the configured budget. Called at most once, only when a trace mapping
   * found nothing in the messages and the local spans.
   */
  fetchRemoteTraces?: () => Promise<void>;
}

const logger = new Logger("scenario.evaluators.runScenarioEvaluators");

function truncate(text: string): string {
  return text.length > EVALUATION_INPUT_MAX_CHARS
    ? text.slice(0, EVALUATION_INPUT_MAX_CHARS)
    : text;
}

/**
 * Evaluators read contexts as a list. A field or a literal mapped to a
 * contexts input arrives as one string, so it becomes a one-item list.
 */
function coerceDataValue({ inputId, value }: { inputId: string; value: unknown }): unknown {
  if (inputId.toLowerCase().endsWith("contexts") && typeof value === "string") {
    return [value];
  }
  return value;
}

interface ResolvedInputs {
  data: Record<string, unknown>;
  inputs: Record<string, string>;
  skipped?: string;
  failed?: string;
}

/**
 * Resolves every mapping. An input that resolves to nothing reports (skip or
 * fail) when the evaluator requires it or the author mapped it by hand; an
 * inferred optional input that resolves to nothing is left out of the call.
 */
function resolveAll({
  spec,
  mappings,
  explicitIds,
  context,
}: {
  spec: EvaluatorSpec;
  mappings: Record<string, EvaluatorMapping>;
  explicitIds: Set<string>;
  context: EvaluatorInputContext;
}): ResolvedInputs {
  const resolved: ResolvedInputs = { data: {}, inputs: {} };
  const requiredIds = new Set(
    spec.inputs.filter((input) => input.required).map((input) => input.id)
  );
  for (const [inputId, mapping] of Object.entries(mappings)) {
    const outcome: ResolvedInput = resolveInput({ mapping, context });
    if (outcome.kind === "value") {
      resolved.data[inputId] = coerceDataValue({ inputId, value: outcome.value });
      resolved.inputs[inputId] = truncate(displayValue(outcome.value));
      continue;
    }
    if (!requiredIds.has(inputId) && !explicitIds.has(inputId)) continue;
    if (outcome.kind === "skipped") resolved.skipped ??= outcome.reason;
    else resolved.failed ??= outcome.reason;
  }
  return resolved;
}

function fromApiResponse({
  response,
  base,
}: {
  response: EvaluateApiResponse;
  base: Pick<EvaluationResult, "evaluatorId" | "name" | "inputs">;
  }): Omit<EvaluationResult, "required"> {
  if (response.status === "error") {
    return { ...base, status: "error", details: response.details };
  }
  if (response.status === "skipped") {
    return {
      ...base,
      status: "skipped",
      details: response.details ?? undefined,
      cost: response.cost ?? undefined,
    };
  }
  const passed = response.passed ?? undefined;
  return {
    ...base,
    status: passed === undefined ? "scored" : passed ? "passed" : "failed",
    passed,
    score: response.score ?? undefined,
    label: response.label ?? undefined,
    details: response.details ?? undefined,
    cost: response.cost ?? undefined,
  };
}

async function runOne({
  attachment,
  context,
  traceId,
  deps,
  fetchOnce,
}: {
  attachment: ScenarioEvaluator;
  context: () => EvaluatorInputContext;
  traceId: string | undefined;
  deps: RunEvaluatorsDeps;
  fetchOnce: () => Promise<void>;
}): Promise<EvaluationResult> {
  const ref = attachment.evaluator;
  let spec: EvaluatorSpec | undefined;
  try {
    spec = await deps.getEvaluatorSpec(ref);
  } catch (error) {
    return {
      evaluatorId: ref,
      name: ref,
      status: "error",
      required: attachment.required ?? false,
      details: `Could not load evaluator ${ref}: ${(error as Error).message}`,
    };
  }
  if (!spec) {
    return {
      evaluatorId: ref,
      name: ref,
      status: "error",
      required: attachment.required ?? false,
      details: `Evaluator ${ref} was not found in LangWatch`,
    };
  }

  const required = attachment.required ?? spec.producesPassed;
  const base = { evaluatorId: spec.evaluatorId, name: spec.name };
  const mappings = inferEvaluatorMappings({
    inputs: spec.inputs.map((input) => input.id),
    fieldNames: Object.keys(context().fields),
    mappings: attachment.mappings,
  });

  const unmapped = spec.inputs
    .filter((input) => input.required && !mappings[input.id])
    .map((input) => input.id);
  if (unmapped.length > 0) {
    return {
      ...base,
      status: "error",
      required,
      details: `No mapping for the required input${unmapped.length > 1 ? "s" : ""} ${unmapped.join(", ")} of ${spec.name}`,
    };
  }

  const explicitIds = new Set(Object.keys(attachment.mappings ?? {}));
  let resolved = resolveAll({ spec, mappings, explicitIds, context: context() });
  if (
    resolved.failed &&
    deps.fetchRemoteTraces &&
    Object.values(mappings).some(readsTrace)
  ) {
    await fetchOnce();
    resolved = resolveAll({ spec, mappings, explicitIds, context: context() });
  }
  if (resolved.skipped) {
    return { ...base, status: "skipped", required, details: resolved.skipped, inputs: resolved.inputs };
  }
  if (resolved.failed) {
    return { ...base, status: "failed", required, passed: false, details: resolved.failed, inputs: resolved.inputs };
  }

  try {
    const response = await deps.evaluate({
      evaluatorRef: ref,
      data: resolved.data,
      settings: attachment.settings,
      traceId,
    });
    return { ...fromApiResponse({ response, base: { ...base, inputs: resolved.inputs } }), required };
  } catch (error) {
    return {
      ...base,
      status: "error",
      required,
      details: (error as Error).message,
      inputs: resolved.inputs,
    };
  }
}

/**
 * Runs every evaluator of the scenario in parallel and returns one result
 * per evaluator, in the order the scenario lists them. Never throws: a
 * failure to load or call an evaluator is an `error` result.
 */
export async function runScenarioEvaluators({
  evaluators,
  context,
  traceId,
  deps,
}: {
  evaluators: ScenarioEvaluator[];
  context: Omit<EvaluatorInputContext, "spans">;
  traceId: string | undefined;
  deps: RunEvaluatorsDeps;
}): Promise<EvaluationResult[]> {
  let remoteFetch: Promise<void> | undefined;
  const fetchOnce = () => {
    remoteFetch ??= (deps.fetchRemoteTraces?.() ?? Promise.resolve()).catch(
      (error) => {
        logger.warn(`Remote trace fetch for evaluators failed: ${(error as Error).message}`);
      }
    );
    return remoteFetch;
  };
  const contextWithSpans = () => ({ ...context, spans: deps.getSpans() });

  return Promise.all(
    evaluators.map((attachment) =>
      runOne({ attachment, context: contextWithSpans, traceId, deps, fetchOnce })
    )
  );
}

/**
 * Applies evaluations to the run result: a required evaluator that failed
 * fails the run and its reason joins the reasoning. Scores never gate.
 */
export function applyEvaluationsToResult({
  result,
  evaluations,
}: {
  result: ScenarioResult;
  evaluations: EvaluationResult[];
}): ScenarioResult {
  const gating = evaluations.filter(
    (evaluation) => evaluation.required && evaluation.status === "failed"
  );
  if (gating.length === 0) return { ...result, evaluations };

  const reasons = gating.map(
    (evaluation) =>
      `Evaluator ${evaluation.name} failed${evaluation.details ? `: ${evaluation.details}` : ""}`
  );
  return {
    ...result,
    success: false,
    reasoning: [result.reasoning, ...reasons].filter(Boolean).join("\n"),
    evaluations,
  };
}
