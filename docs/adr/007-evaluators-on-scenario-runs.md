# ADR-007: Evaluators on scenario runs

**Date:** 2026-09-03

**Status:** Accepted

## Context

The judge decides a scenario from the transcript and the trace against free-text criteria. Some checks need a structured reference the transcript does not carry (a golden SQL query, a table schema), evidence outside the transcript (the arguments of a tool call, the retrieved contexts), a deterministic comparison, or a judge already saved on the LangWatch platform. The platform's test suites gained fields (typed values per scenario) and evaluator attachments with input mappings, run server-side after each scenario run. Code-first users had no equivalent: a script step could call an evaluator by hand, but nothing carried the result to the run, gated the verdict, or matched the platform's mapping rules.

## Decision

`run` accepts `fields` (a map of values the scenario carries next to its description) and `evaluators` (attachments built with `scenario.evaluator(ref, required?, mappings?, settings?)`), in both languages with the same shape. The reference is what the LangWatch evaluate endpoint accepts: a built-in type (`ragas/sql_query_equivalence`) or a saved evaluator (`evaluators/<slug>`).

A mapping is a function of the scenario state, the same `ScenarioState` (Python) or `ScenarioExecutionStateLike` (TypeScript) a script step receives, sync or async, or a literal for a constant. The state grows the accessors an evaluator needs, and script steps get them too: `fields`, `field(name)`, `criteria`, `first_user_message()`, `last_agent_message()` (Python; TypeScript keeps `lastAgentMessage()` as the message accessor), `transcript()`, `tool_calls(name)` (a collection with `first`, `last`, `inputs`, `outputs`, iteration, length and indexing; each call carries `name`, `input`, `output`, `turn` and `source`), `contexts`, `spans`, `traces` and `turns`. `tool_calls(name)` merges the tool calls of the assistant messages and the tool spans of the traces in start order, turn by turn, and does not list a span that describes a call the messages already carry. The whole run is the default scope; `turns[i]` and `traces[i]` narrow it.

The helpers `conversation.*`, `scenario_source.*`, `field(name)`, `trace.tool_calls(name).first|last.input|output`, `trace.tool_calls(name).inputs|outputs`, `trace.contexts`, `trace.spans` and `value(literal)` are documented sugar: each returns exactly that kind of function, and carries the expression it stands for in its docstring and its `expression` attribute. Inference by input name produces the same functions. The three platform sources (`conversation`, `scenario`, `trace`) and their paths stay the vocabulary of the platform picker; the docs list them in one table next to the state accessor and the helper for each.

No mapping object travels to the platform: a code run resolves every input itself and sends only the resolved values (`results.evaluations[].inputs`). That is why nothing in code needs to be serialisable, and why a function is the natural form.

Inputs an evaluator declares but the author did not map are inferred by name with the platform's rules: conversation inputs by their name (`input`, `output`, `contexts`, ...), expected-like inputs (`expected_*`, `golden`, `reference`, `ground_truth`) to the one field whose name shares a word with the input (a single declared field takes every expected-like input; several candidates leave the input unmapped), and a tool call never. Which inputs an evaluator takes, and whether it answers pass or fail, come from LangWatch: the evaluator catalogue for a built-in type, the saved record then the catalogue of its type for a saved evaluator.

Evaluators run once the run has a verdict (the judge decided, a script step ended it, or the checkpoints or the turn limit did), and never on a run that ended in an error. Mappings resolve one evaluator at a time against the state; the evaluate calls run in parallel. A mapping that returns nothing (`None`/`undefined` or an empty list) skips the evaluator; the state records what the mapping read, so the reason is the most specific one it knows: `no <field> on this scenario` for a blank field, `no <tool> call in the trace` for a tool never called, `no retrieved contexts in the trace`, otherwise `the mapping returned nothing`. A mapping that raises is an `error` with the message. An unknown evaluator, an unmapped required input or a failing evaluate call is an `error` with details. An inferred optional input that resolves to nothing is left out of the call. The evaluate call carries the `trace_id` of the last turn so the evaluation also lands on that trace.

Trace fetching stays lazy and `state.spans` never raises: a script step reads what the collector holds. The state flags that a trace accessor was read (`spans`, `traces`, `contexts`, `tool_calls`, a turn's trace). When a mapping read the trace and resolved to nothing while the messages carry trace ids, the runner fetches the remote traces once (one settle-wait of the remote trace fetcher over every turn's trace ids, under the configured trace wait budget) and calls the mapping again.

`fields` is the scenario's data row: readable as `state.fields` and `state.field(name)`, used by name inference, and sent on the `SCENARIO_RUN_STARTED` metadata so the platform scenario shows the values it ran with.

`required` defaults to whether the evaluator answers pass or fail. A required evaluator with status `failed` sets `success` to false and appends `Evaluator <name> failed: <details>` to the reasoning; met and unmet criteria stay as the judge left them. A score never gates. `ScenarioResult` gains `evaluations`, one result per attachment in declaration order, with `evaluator_id` (the saved evaluator id, or the type), `name`, `status` (`passed`, `failed`, `scored`, `skipped`, `error`), `required`, `passed`, `score`, `label`, `details`, `cost` and `inputs` (the resolved values cut to 2000 characters). The `SCENARIO_RUN_FINISHED` event sends them as `results.evaluations` in the platform's camel case schema, and only when the scenario declared evaluators: the platform stores a list it receives as is and skips its own evaluators, so an absent key is what lets a platform-run scenario evaluate server-side.

The TypeScript event schema (`javascript/src/events/schema.ts`, synced from the platform) gains `scenarioEvaluationResultSchema` and the optional `evaluations` list. The Python client is generated from the platform's published specification, which does not carry the field yet, so `ScenarioRunFinishedEventResults` extends the generated results model with `evaluations` the same way the started event's metadata extends the generated model with `agents`.

## Rationale / Trade-offs

A mapping as a function of the state, rather than a wire object, follows from three facts. It is code, so a function is the natural form and any expression over the run is one lambda away (`state.turns[-1].tool_calls("run_sql").first.output`, a filter over `state.spans`). A wire object such as `{type: "source", sourceId: "trace", path: ["tool_calls", "run_sql", "input"]}` did not say which trace or which call it meant; the rule lived in a resolver, while `state.tool_calls("run_sql").last.input` names the pick. And the platform never receives a code run's mappings, only the resolved values, so mirroring the stored shape bought nothing. One object serves script steps and evaluators, so there is no second vocabulary to learn, and a future builder (`.evaluators([...])` over a dataset row) is one more step over the same state, whose `fields` is the current row.

Missing evidence skips rather than fails: a mapping that finds nothing cannot say the agent was wrong, only that the check could not run, and the status and details say so on the results page. A required evaluator still gates the run when it answers `failed`.

Reading tool calls from the messages first keeps in-process agents fast and free of network: most adapters return their tool calls, and the remote fetch is a fallback bounded by the same budget the judge already pays. Letting the evaluator reference and the input list come from the platform avoids a second copy of the evaluator catalogue in each language; the cost is one catalogue request per run with evaluators. Inference mirrors the platform's rules so a suite exported to code keeps the same mappings, at the cost of a small word list that both sides maintain. Error results never gate: a misconfigured evaluator reports instead of failing a run the judge passed, and the verbose output prints every evaluator status so the misconfiguration is visible.

## Consequences

A scenario can carry references and run deterministic or reusable checks next to the judge, and their results show in LangWatch's agent testing results with the verdict. Runs with evaluators need a LangWatch API key and pay the evaluate calls. The platform must accept `results.evaluations` on the run finished event with the schema above and skip its server-side evaluation step when the key is present.

## References

- Spec: `specs/scenario-evaluators.feature`, `specs/scenario-state-accessors.feature`
- Guide: `docs/docs/pages/advanced/evaluators.mdx`
- Remote trace fetching: ADR-006
