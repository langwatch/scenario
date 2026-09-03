# ADR-007: Evaluators on scenario runs

**Date:** 2026-09-03

**Status:** Accepted

## Context

The judge decides a scenario from the transcript and the trace against free-text criteria. Some checks need a structured reference the transcript does not carry (a golden SQL query, a table schema), evidence outside the transcript (the arguments of a tool call, the retrieved contexts), a deterministic comparison, or a judge already saved on the LangWatch platform. The platform's test suites gained fields (typed values per scenario) and evaluator attachments with input mappings, run server-side after each scenario run. Code-first users had no equivalent: a script step could call an evaluator by hand, but nothing carried the result to the run, gated the verdict, or matched the platform's mapping rules.

## Decision

`run` accepts `fields` (a map of values the scenario carries next to its description) and `evaluators` (attachments built with `scenario.evaluator(ref, required?, mappings?, settings?)`), in both languages with the same shape. The reference is what the LangWatch evaluate endpoint accepts: a built-in type (`ragas/sql_query_equivalence`) or a saved evaluator (`evaluators/<slug>`).

A mapping is the platform's own shape, `{ type: "source", sourceId, path }` or `{ type: "value", value }`, with three sources: `conversation` (first user message, last agent message, transcript, messages), `scenario` (situation, criteria, `fields.<name>`) and `trace` (`contexts`, `tool_calls.<name>.input|output`). The helpers `conversation.*`, `scenario_source.*`, `field(name)`, `trace.tool_call(name).input|output`, `trace.contexts` and `value(literal)` build them. Storing the platform shape means a scenario defined in code and one defined on the platform describe the same attachment, and the wire needs no converter.

Inputs an evaluator declares but the author did not map are inferred by name with the platform's rules: conversation inputs by their name (`input`, `output`, `contexts`, ...), expected-like inputs (`expected_*`, `golden`, `reference`, `ground_truth`) to the one field whose name shares a word with the input (a single declared field takes every expected-like input; several candidates leave the input unmapped), and a tool call never. Which inputs an evaluator takes, and whether it answers pass or fail, come from LangWatch: the evaluator catalogue for a built-in type, the saved record then the catalogue of its type for a saved evaluator.

Evaluators run once the run has a verdict (the judge decided, a script step ended it, or the checkpoints or the turn limit did), in parallel, and never on a run that ended in an error. Each input resolves from the run state: tool calls from the `tool_calls` of the assistant messages first, then from the tool spans in the judge span collector (local spans and remote spans the judge already merged), and only when a trace mapping still finds nothing, one settle-wait of the remote trace fetcher under the configured trace wait budget. A blank field skips the evaluator with `no <field> on this scenario`; a missing tool call or missing contexts fails it with `no <tool> call in the trace` / `no retrieved contexts in the trace`; an unknown evaluator, an unmapped required input or a failing evaluate call is an `error` with details. An inferred optional input that resolves to nothing is left out of the call. The evaluate call carries the `trace_id` of the last turn so the evaluation also lands on that trace.

`required` defaults to whether the evaluator answers pass or fail. A required evaluator with status `failed` sets `success` to false and appends `Evaluator <name> failed: <details>` to the reasoning; met and unmet criteria stay as the judge left them. A score never gates. `ScenarioResult` gains `evaluations`, one result per attachment in declaration order, with `evaluator_id` (the saved evaluator id, or the type), `name`, `status` (`passed`, `failed`, `scored`, `skipped`, `error`), `required`, `passed`, `score`, `label`, `details`, `cost` and `inputs` (the resolved values cut to 2000 characters). The `SCENARIO_RUN_FINISHED` event sends them as `results.evaluations` in the platform's camel case schema, and only when the scenario declared evaluators: the platform stores a list it receives as is and skips its own evaluators, so an absent key is what lets a platform-run scenario evaluate server-side.

The TypeScript event schema (`javascript/src/events/schema.ts`, synced from the platform) gains `scenarioEvaluationResultSchema` and the optional `evaluations` list. The Python client is generated from the platform's published specification, which does not carry the field yet, so `ScenarioRunFinishedEventResults` extends the generated results model with `evaluations` the same way the started event's metadata extends the generated model with `agents`.

## Rationale / Trade-offs

Reading tool calls from the messages first keeps in-process agents fast and free of network: most adapters return their tool calls, and the remote fetch is a fallback bounded by the same budget the judge already pays. Letting the evaluator reference and the input list come from the platform avoids a second copy of the evaluator catalogue in each language; the cost is one catalogue request per run with evaluators. Inference mirrors the platform's rules so a suite exported to code keeps the same mappings, at the cost of a small word list that both sides maintain. Error results never gate: a misconfigured evaluator reports instead of failing a run the judge passed, and the verbose output prints every evaluator status so the misconfiguration is visible.

## Consequences

A scenario can carry references and run deterministic or reusable checks next to the judge, and their results show in LangWatch's agent testing results with the verdict. Runs with evaluators need a LangWatch API key and pay the evaluate calls. The platform must accept `results.evaluations` on the run finished event with the schema above and skip its server-side evaluation step when the key is present.

## References

- Spec: `specs/scenario-evaluators.feature`
- Guide: `docs/docs/pages/advanced/evaluators.mdx`
- Remote trace fetching: ADR-006
