/**
 * Runs the evaluators attached to a scenario once the run has a verdict, and
 * applies their results to the run: a required evaluator that fails fails
 * the scenario, a score only reports.
 */
import type {
  EvaluationResult,
  EvaluatorMapping,
  ScenarioEvaluator,
  ScenarioResult,
} from "../domain";
import type { EvaluateApiResponse, EvaluatorSpec } from "./evaluations-api";
import { inferEvaluatorMappings } from "./inference";
import { resolveMapping, type EvaluatorState } from "./resolve-mapping";
import { stringify } from "../execution/state-views";
import { collectMessageTraceIds } from "../tracing/remote-trace-fetcher";
import { Logger } from "../utils/logger";

/** The largest `inputs` value an evaluation result carries. */
export const EVALUATION_INPUT_MAX_CHARS = 2000;

/** What the runner needs from LangWatch and from the run. */
export interface RunEvaluatorsDeps {
  getEvaluatorSpec: (evaluatorRef: string) => Promise<EvaluatorSpec | undefined>;
  evaluate: (args: {
    evaluatorRef: string;
    data: Record<string, unknown>;
    settings?: Record<string, unknown>;
    traceId?: string;
  }) => Promise<EvaluateApiResponse>;
  /**
   * Fetches the remote traces of the run into the span collector, waiting
   * the configured budget. Called at most once, only when a mapping read the
   * trace and found nothing while the messages carry trace ids.
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
  error?: string;
  /** A mapping read the trace and found nothing. */
  wantsTrace: boolean;
}

/**
 * Resolves every mapping. An input that resolves to nothing reports a skip
 * when the evaluator requires it or the author mapped it by hand; an
 * inferred optional input that resolves to nothing is left out of the call.
 * A mapping that throws reports an error.
 */
async function resolveAll({
  spec,
  mappings,
  explicitIds,
  state,
}: {
  spec: EvaluatorSpec;
  mappings: Record<string, EvaluatorMapping>;
  explicitIds: Set<string>;
  state: EvaluatorState;
}): Promise<ResolvedInputs> {
  const resolved: ResolvedInputs = { data: {}, inputs: {}, wantsTrace: false };
  const requiredIds = new Set(
    spec.inputs.filter((input) => input.required).map((input) => input.id)
  );
  for (const [inputId, mapping] of Object.entries(mappings)) {
    const outcome = await resolveMapping({ mapping, state });
    if (outcome.kind === "value") {
      resolved.data[inputId] = coerceDataValue({ inputId, value: outcome.value });
      resolved.inputs[inputId] = truncate(stringify(outcome.value));
      continue;
    }
    if (outcome.kind === "error") {
      resolved.error ??= `Mapping of ${inputId} failed: ${outcome.error.message}`;
      continue;
    }
    resolved.wantsTrace ||= outcome.readTrace;
    if (!requiredIds.has(inputId) && !explicitIds.has(inputId)) continue;
    resolved.skipped ??= outcome.reason;
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

interface Prepared {
  attachment: ScenarioEvaluator;
  spec: EvaluatorSpec;
  required: boolean;
  mappings: Record<string, EvaluatorMapping>;
  explicitIds: Set<string>;
}

type PreparedOrResult = { prepared: Prepared } | { result: EvaluationResult };

/** Loads the evaluator and completes its mappings. */
async function prepare({
  attachment,
  state,
  deps,
}: {
  attachment: ScenarioEvaluator;
  state: EvaluatorState;
  deps: RunEvaluatorsDeps;
}): Promise<PreparedOrResult> {
  const ref = attachment.evaluator;
  let spec: EvaluatorSpec | undefined;
  try {
    spec = await deps.getEvaluatorSpec(ref);
  } catch (error) {
    return {
      result: {
        evaluatorId: ref,
        name: ref,
        status: "error",
        required: attachment.required ?? false,
        details: `Could not load evaluator ${ref}: ${(error as Error).message}`,
      },
    };
  }
  if (!spec) {
    return {
      result: {
        evaluatorId: ref,
        name: ref,
        status: "error",
        required: attachment.required ?? false,
        details: `Evaluator ${ref} was not found in LangWatch`,
      },
    };
  }

  const required = attachment.required ?? spec.producesPassed;
  const mappings = inferEvaluatorMappings({
    inputs: spec.inputs.map((input) => input.id),
    fieldNames: Object.keys(state.fields),
    mappings: attachment.mappings,
  });
  const unmapped = spec.inputs
    .filter((input) => input.required && mappings[input.id] === undefined)
    .map((input) => input.id);
  if (unmapped.length > 0) {
    return {
      result: {
        evaluatorId: spec.evaluatorId,
        name: spec.name,
        status: "error",
        required,
        details: `No mapping for the required input${unmapped.length > 1 ? "s" : ""} ${unmapped.join(", ")} of ${spec.name}`,
      },
    };
  }
  return {
    prepared: {
      attachment,
      spec,
      required,
      mappings,
      explicitIds: new Set(Object.keys(attachment.mappings ?? {})),
    },
  };
}

async function callEvaluator({
  prepared,
  resolved,
  traceId,
  deps,
}: {
  prepared: Prepared;
  resolved: ResolvedInputs;
  traceId: string | undefined;
  deps: RunEvaluatorsDeps;
}): Promise<EvaluationResult> {
  const { spec, required, attachment } = prepared;
  const base = { evaluatorId: spec.evaluatorId, name: spec.name };
  if (resolved.error) {
    return { ...base, status: "error", required, details: resolved.error, inputs: resolved.inputs };
  }
  if (resolved.skipped) {
    return { ...base, status: "skipped", required, details: resolved.skipped, inputs: resolved.inputs };
  }
  try {
    const response = await deps.evaluate({
      evaluatorRef: attachment.evaluator,
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
 * Runs every evaluator of the scenario and returns one result per
 * evaluator, in the order the scenario lists them. Mappings resolve one
 * evaluator at a time against the state; the evaluate calls run in
 * parallel. Never throws: a failure to load or call an evaluator is an
 * `error` result.
 */
export async function runScenarioEvaluators({
  evaluators,
  state,
  traceId,
  deps,
}: {
  evaluators: ScenarioEvaluator[];
  state: EvaluatorState;
  traceId: string | undefined;
  deps: RunEvaluatorsDeps;
}): Promise<EvaluationResult[]> {
  let remoteFetch: Promise<void> | undefined;
  const canFetch =
    deps.fetchRemoteTraces !== undefined && collectMessageTraceIds(state.messages).length > 0;
  const fetchOnce = () => {
    remoteFetch ??= (deps.fetchRemoteTraces?.() ?? Promise.resolve()).catch((error) => {
      logger.warn(`Remote trace fetch for evaluators failed: ${(error as Error).message}`);
    });
    return remoteFetch;
  };

  const preparedAll = await Promise.all(
    evaluators.map((attachment) => prepare({ attachment, state, deps }))
  );

  const calls: Promise<EvaluationResult>[] = [];
  for (const entry of preparedAll) {
    if ("result" in entry) {
      calls.push(Promise.resolve(entry.result));
      continue;
    }
    const { prepared } = entry;
    const fetchedBefore = remoteFetch !== undefined;
    let resolved = await resolveAll({ ...prepared, state });
    if (resolved.wantsTrace && canFetch && !fetchedBefore) {
      await fetchOnce();
      resolved = await resolveAll({ ...prepared, state });
    }
    calls.push(callEvaluator({ prepared, resolved, traceId, deps }));
  }
  return Promise.all(calls);
}

/** True when a required evaluator with this status fails the run. */
function gates(evaluation: EvaluationResult): boolean {
  return evaluation.required && (evaluation.status === "failed" || evaluation.status === "error");
}

/**
 * Applies evaluations to the run result: a required evaluator that failed,
 * or that could not run, fails the run and its reason joins the reasoning.
 * Scores and skips never gate. The same rule the platform applies to a run
 * it evaluates itself.
 */
export function applyEvaluationsToResult({
  result,
  evaluations,
}: {
  result: ScenarioResult;
  evaluations: EvaluationResult[];
}): ScenarioResult {
  const gating = evaluations.filter(gates);
  if (gating.length === 0) return { ...result, evaluations };

  const reasons = gating.map((evaluation) => {
    const what = evaluation.status === "error" ? "could not run" : "failed";
    return `Evaluator ${evaluation.name} ${what}${evaluation.details ? `: ${evaluation.details}` : ""}`;
  });
  return {
    ...result,
    success: false,
    reasoning: [result.reasoning, ...reasons].filter(Boolean).join("\n"),
    evaluations,
  };
}
