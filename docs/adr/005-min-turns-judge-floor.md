# ADR-005: `minTurns` — a guaranteed-turns floor the judge cannot end early (#899)

**Date:** 2026-08-14

**Status:** Accepted

**Companion docs:** [ADR-001 Concurrency](./001-scenario-concurrency-model.md) · [ADR-002 Voice Provider State](./002-voice-provider-state.md) · [ADR-003 Voice Internal Design](./003-voice-internal-design.md) · [ADR-004 ffmpeg Bundling](./004-ffmpeg-bundling.md)

**Issue:** https://github.com/langwatch/scenario/issues/899

> One-line: an **opt-in** `minTurns` config field guarantees the first **minTurns turns** of a scenario run cannot be ended by a **volunteered** judge verdict — the judge's `finish_test` tool is **withheld** on unforced judgments while the floor is unmet; **forced judgments always win**.

## Why this doc exists

The judge inspects the conversation after every turn and may end the run. On
turn 1, positive criteria are unmet by definition — the agent has not had a
chance to act — and the judge sometimes reads "not met yet" as "failed",
killing the run immediately. PR #889 fixed the *inconclusive* half of that
problem (an unforced inconclusive `finish_test` now continues the conversation
instead of failing the run), but explicit early *failure* verdicts remained
possible from turn 1, and prompt guidance alone demonstrably did not stop
them. `maxTurns` has had no symmetric floor. This record captures what
`minTurns` guarantees, how the guarantee is enforced structurally, and which
early-exit paths are deliberately outside its jurisdiction.

## Context

Prior art this decision must not disturb:

- `maxTurns` config: `javascript/src/domain/scenarios/index.ts` (`DEFAULT_MAX_TURNS = 10`); run-fail check in `scenario-execution.ts`.
- Judge toolChoice seam: `javascript/src/agents/judge/judge-agent.ts`; Python mirror `python/scenario/judge_agent.py`. One tools-build site and one forced-pin site per SDK; voice routes through the same seam.
- Turn counting: `newTurn()` / `_new_turn()` increments `currentTurn` at the start of each turn, **but the executor's constructor overrides the initial increment back to 0** (`scenario-execution.ts` reset, `scenario_executor.py` `reset()`), so the first full turn runs with `currentTurn = 0` and the judge observes a **0-based** value: the call on turn N sees `currentTurn = N-1`. Last-turn forcing reads the same field at `currentTurn >= maxTurns - 1` — with `maxTurns: 5` the turn-5 call (`currentTurn = 4`) is the last-message call.
- #889 invariants: unforced inconclusive ⇒ continue; a required judgment ⇒ terminal verdict, including the discovery loop's forced-verdict path.

## Decision

1. **Add optional `minTurns` (JS) / `min_turns` (Python) to the scenario config**, alongside `maxTurns`. Optional because any default > 0 would change behavior for every existing user; unset ⇒ behavior identical to today. Rejects: a nonzero default.
2. **Semantics — a floor of guaranteed turns, defined observably.** With `minTurns: 4`, turns 1–4 always run; the judge may first volunteer a verdict on its turn-5 call. Because the judge observes a 0-based `currentTurn` (see Context), the gate is `currentTurn < minTurns` at judge-call time: the turn-N call sees `currentTurn = N-1`, so `< minTurns` gates exactly calls 1..minTurns. The comparison is pinned by turn-sequence tests asserting the first call on which `finish_test` appears — the raw expression is explicitly not the contract. Rejects: "verdict allowed ON turn minTurns" (one fewer guaranteed turn; asymmetric with the ceiling).
3. **Enforcement is structural, not advisory: withhold the tool.** While gated, **unforced** judgments do not receive `finish_test` in their tool set at all — `continue_test` (and discovery tools on large traces) remain. Withholding is the only hard guarantee; a prompt instruction is already in place and demonstrably insufficient. Rejects: prompt-only enforcement; keeping the tool but pinning `toolChoice` to `continue_test` (blocks discovery tools on large traces).
4. **Forced judgments always deliver their terminal verdict**, gate or no gate: explicit `judge()` checkpoint, last turn (`currentTurn >= maxTurns - 1`), discovery exhaustion under a required judgment. A script line that says "judge now" gets an answer; `minTurns` only silences *volunteered* verdicts. This preserves every #889 invariant. Rejects: silently skipping a `judge()` checkpoint; erroring on early checkpoints (not statically detectable for dynamic scripts).
5. **Discovery exhaustion below the floor resolves to continue, not a forced verdict.** When a large-trace judge burns its discovery budget without a terminal tool call, `forceVerdict` / `_force_verdict` fires unconditionally and pins `toolChoice` to `finish_test`. With `finish_test` withheld, that emits a `tool_choice` referencing a tool absent from `tools`: providers reject it and the run dies with `ScenarioRunStatus.ERROR`. Therefore: on gated calls, exhaustion yields a synthetic continue and the force path must not fire. Consistent with the core rule — an exhaustion-forced verdict on an *unforced* call is a volunteered verdict. Above the floor, exhaustion behavior is untouched.
6. **One added judge system-prompt line** on gated calls, telling the model that ending the test is not available on this turn — so the model cooperates instead of fighting the missing tool. Appended to custom `systemPrompt` overrides too.
7. **Startup validation: `minTurns > maxTurns` is a config error** raised when the scenario is built, not mid-run. `minTurns == maxTurns` is legal: every turn is gated for volunteered verdicts and the forced last-turn judgment (which always wins) delivers the only verdict.
8. **One-off, not scaffolding.** A config field plus one gate at an existing seam — first occurrence, low blast radius. Built inline, no shared abstraction.
9. **`minTurns` governs the judge only — other early exits are explicitly out of its jurisdiction.** Red-team marathon runs may still end before the floor via the executor's success path when the attack scorer confirms success on consecutive turns (on by default). That exit fires on a *confirmed attack success* — a fact, not the premature "criteria not met yet" misread `minTurns` treats — and delaying it would only burn LLM calls after confirmation. Likewise `scenario.succeed()` / `scenario.fail()` script steps are explicit author decisions (same standing as a forced `judge()` checkpoint). Both are documented as non-goals.
10. **Ship: one PR, both SDKs in parity** (repo norm — #889 shipped that way), including regression tests and docs.

## Constants

| Name | Value | Purpose |
| --- | --- | --- |
| `minTurns` / `min_turns` | unset (no default) | Opt-in floor; unset preserves today's behavior exactly |
| Gate condition | `currentTurn < minTurns` at judge-call time (judge observes 0-based; turn-N call sees N−1) | Guarantees exactly `minTurns` turns free of volunteered verdicts; pinned by observable test, not raw expression |
| Validation | error iff `minTurns > maxTurns` | At scenario build time |

## Invariants

| Invariant | Meaning | Test anchor |
| --- | --- | --- |
| Unset ⇒ identical | Without `minTurns`, judge tool offers are identical to today | `judge-min-turns.test.ts` / `test_judge_min_turns.py` (unset case), both SDKs |
| Gated ⇒ no verdict possible | Unforced call below floor has no `finish_test` in its tool set | Assert on the tools dict, not just toolChoice |
| Forced ⇒ terminal, always | `judge()` checkpoint / last turn / required-judgment discovery exhaustion return a verdict even below floor | Checkpoint-before-floor tests, both SDKs |
| #889 survives | Unforced inconclusive still continues; required judgment cannot be dodged | Existing #889 suites stay green untouched |
| Discovery works while gated | Large-trace gated call still offers discovery tools + `continue_test` | Large-trace gated tests |
| Gated exhaustion continues cleanly | Discovery-budget exhaustion below the floor produces a continue, never a forced verdict, malformed `tool_choice`, or `ScenarioRunStatus.ERROR` | Stub model calling only discovery tools for `maxDiscoverySteps` while gated |
| Floor holds end-to-end | An eager judge that would end the run on turn 1 is held open; with `minTurns: 2` the verdict lands on the turn-3 call | `min-turns-judge-floor.test.ts` / `TestFloorHoldsEndToEnd` |

## Consequences

- **Positive:** turn-1 false failures become impossible for anyone who sets the floor; the fix is a hard guarantee, not a prompt hope; symmetric, teachable mental model (floor/ceiling).
- **Negative:** a genuinely catastrophic early failure cannot end the run via the judge while below a user-set floor — this is the explicit, opted-into tradeoff, and why the default is unset. Judges below the floor still burn an LLM call per turn only to say "continue" (unchanged from today's cost shape).
- **Neutral:** judge eagerness itself (prompt calibration) is untouched — a separate lever if early failures persist for users who don't set `minTurns`.

## Revisions

- **v1 (2026-08-14)** — Initial draft: scope, forced-wins precedence, guaranteed-turns semantics, opt-in default, build-time validation.
- **v2 (2026-08-14)** — Challenge pass (correctness / second-order / coverage). Added Decision 5 (gated discovery exhaustion resolves to continue — the unconditional force path would otherwise emit a malformed request and error the run) and Decision 9 (judge-only jurisdiction; red-team early exit and `succeed()`/`fail()` script steps are non-goals).
- **v3 (2026-08-14, implementation)** — Gate expression corrected, observable semantics unchanged. The v2 "1-based at judge time" conclusion missed that both executors override the constructor's initial turn increment back to 0, so the judge observes 0-based and the gate is `currentTurn < minTurns`. Caught by the executor-level floor test (`<=` gated one turn too many). Exactly the failure mode Decision 2 anticipated by pinning the observable turn sequence rather than the expression.
