/**
 * The LangWatch evaluations API as the scenario runner uses it: the evaluator
 * catalogue (which inputs an evaluator takes), saved evaluators, and the
 * evaluate call itself. Same endpoint and headers as the LangWatch SDKs.
 */
import { getEnv } from "../config";
import type { LangwatchConfig } from "../domain";
import { Logger } from "../utils/logger";

/** What the runner needs to know about an evaluator before running it. */
export interface EvaluatorSpec {
  /** The saved evaluator id, or the evaluator type when run by type. */
  evaluatorId: string;
  name: string;
  /** Inputs the evaluator reads, required ones first. */
  inputs: { id: string; required: boolean }[];
  /** Whether the evaluator answers pass or fail (against a score only). */
  producesPassed: boolean;
}

/** The answer of `POST /api/evaluations/{evaluator}/evaluate`. */
export type EvaluateApiResponse =
  | {
      status: "processed";
      score?: number | null;
      passed?: boolean | null;
      label?: string | null;
      details?: string | null;
      cost?: { currency: string; amount: number } | null;
    }
  | { status: "skipped"; details?: string | null; cost?: { currency: string; amount: number } | null }
  | { status: "error"; details: string };

interface CatalogueEntry {
  name: string;
  requiredFields: string[];
  optionalFields: string[];
  result?: Record<string, unknown>;
}

/** One input or output a saved evaluator declares. */
interface SavedEvaluatorField {
  identifier: string;
  type?: string;
  optional?: boolean;
}

interface SavedEvaluator {
  id: string;
  name: string;
  config?: { evaluatorType?: string } | null;
  fields?: SavedEvaluatorField[] | null;
  outputFields?: SavedEvaluatorField[] | null;
}

const SAVED_EVALUATOR_PREFIX = "evaluators/";

/** How long one evaluations API request may take before it is abandoned. */
export const DEFAULT_EVALUATIONS_API_TIMEOUT_MS = 120_000;

export class EvaluationsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationsApiError";
  }
}

export interface EvaluationsApiAuth {
  endpoint: string;
  apiKey: string;
  projectId: string | undefined;
}

/**
 * Resolves the endpoint, key and project the run reports to: the run's own
 * langwatch config first, the environment otherwise.
 */
export function resolveEvaluationsApiAuth(
  langwatch?: LangwatchConfig
): EvaluationsApiAuth {
  const env = getEnv();
  return {
    endpoint: langwatch?.endpoint ?? env.LANGWATCH_ENDPOINT,
    apiKey: langwatch?.apiKey ?? env.LANGWATCH_API_KEY ?? "",
    projectId: langwatch?.projectId ?? env.LANGWATCH_PROJECT_ID,
  };
}

export class EvaluationsApiClient {
  private readonly logger = new Logger("scenario.evaluators.EvaluationsApiClient");
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private catalogue?: Promise<Record<string, CatalogueEntry>>;

  constructor(
    private readonly auth: EvaluationsApiAuth,
    options?: { fetchFn?: typeof fetch; timeoutMs?: number }
  ) {
    this.fetchFn =
      options?.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_EVALUATIONS_API_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.auth.apiKey}`,
      "X-Auth-Token": this.auth.apiKey,
    };
    if (this.auth.projectId) headers["X-Project-Id"] = this.auth.projectId;
    return headers;
  }

  private url(path: string): string {
    return new URL(path, this.auth.endpoint).href;
  }

  private async getJson<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchFn(this.url(path), {
      method: "GET",
      headers: this.headers(),
      // The API key travels in a header, so a redirect to another origin
      // must fail rather than forward it.
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new EvaluationsApiError(
        `GET ${path} answered ${response.status}: ${await response.text()}`
      );
    }
    return (await response.json()) as T;
  }

  private async loadCatalogue(): Promise<Record<string, CatalogueEntry>> {
    this.catalogue ??= this.getJson<{ evaluators: Record<string, CatalogueEntry> }>(
      "/api/evaluations/list"
    ).then((body) => body?.evaluators ?? {});
    return this.catalogue;
  }

  private specFromCatalogue({
    evaluatorId,
    name,
    entry,
  }: {
    evaluatorId: string;
    name?: string;
    entry: CatalogueEntry;
  }): EvaluatorSpec {
    return {
      evaluatorId,
      name: name ?? entry.name,
      inputs: [
        ...entry.requiredFields.map((id) => ({ id, required: true })),
        ...entry.optionalFields.map((id) => ({ id, required: false })),
      ],
      producesPassed: entry.result?.passed !== undefined,
    };
  }

  /**
   * Which inputs an evaluator takes and what to call it. A built-in type is
   * read from the catalogue; a saved evaluator from the fields its record
   * declares, then from the catalogue entry of its type. Undefined when the
   * evaluator is unknown.
   */
  async getEvaluatorSpec(evaluatorRef: string): Promise<EvaluatorSpec | undefined> {
    if (!evaluatorRef.startsWith(SAVED_EVALUATOR_PREFIX)) {
      const catalogue = await this.loadCatalogue();
      const entry = catalogue[evaluatorRef];
      return entry
        ? this.specFromCatalogue({ evaluatorId: evaluatorRef, entry })
        : undefined;
    }

    const idOrSlug = evaluatorRef.slice(SAVED_EVALUATOR_PREFIX.length);
    const saved = await this.getJson<SavedEvaluator>(
      `/api/evaluators/${encodeURIComponent(idOrSlug)}`
    );
    if (!saved) return undefined;

    const fromFields = this.specFromSavedFields(saved);
    if (fromFields) return fromFields;

    const evaluatorType = saved.config?.evaluatorType;
    const catalogue = await this.loadCatalogue();
    const entry = evaluatorType ? catalogue[evaluatorType] : undefined;
    if (entry) {
      return this.specFromCatalogue({ evaluatorId: saved.id, name: saved.name, entry });
    }
    this.logger.debug(
      `Saved evaluator ${evaluatorRef} declares no fields and has no catalogue entry for its type; only explicit mappings are used`
    );
    return { evaluatorId: saved.id, name: saved.name, inputs: [], producesPassed: true };
  }

  /**
   * Runs one evaluator over the resolved inputs. Throws on a transport or
   * HTTP failure; an evaluator failure comes back as `status: "error"`.
   */
  async evaluate({
    evaluatorRef,
    data,
    settings,
    traceId,
  }: {
    evaluatorRef: string;
    data: Record<string, unknown>;
    settings?: Record<string, unknown>;
    traceId?: string;
  }): Promise<EvaluateApiResponse> {
    const path = `/api/evaluations/${evaluatorRef}/evaluate`;
    const response = await this.fetchFn(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        data,
        settings,
        trace_id: traceId ?? null,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new EvaluationsApiError(
        `Evaluation API answered ${response.status}: ${await response.text()}`
      );
    }
    return (await response.json()) as EvaluateApiResponse;
  }

  /**
   * The spec of a saved evaluator from the fields its record declares. A
   * field without an identifier is ignored; a record with no usable field
   * gives nothing, so the catalogue entry of the type is tried next.
   */
  private specFromSavedFields(saved: SavedEvaluator): EvaluatorSpec | undefined {
    const fields = (saved.fields ?? []).filter(
      (f): f is SavedEvaluatorField & { identifier: string } =>
        typeof f?.identifier === "string" && f.identifier.length > 0
    );
    if (fields.length === 0) return undefined;
    const outputs = saved.outputFields ?? [];
    return {
      evaluatorId: saved.id,
      name: saved.name,
      inputs: [
        ...fields.filter((f) => !f.optional).map((f) => ({ id: f.identifier, required: true })),
        ...fields.filter((f) => f.optional).map((f) => ({ id: f.identifier, required: false })),
      ],
      producesPassed: outputs.some((f) => f?.identifier === "passed"),
    };
  }
}
