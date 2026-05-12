# PRD: Indirect Prompt Injection (IPI) red-team strategy

**Owner:** Aryan Sharma (@aryan)
**Status:** Draft — pending review
**Date:** 2026-05-12
**Related:** [Spec](./feat-redteam-ipi.md)

---

## 1. Problem

Every red-team strategy scenario ships today — Crescendo, GOAT, and the candidate TAP work on `feat/redteam-tap-strategy` — attacks the agent through the **user channel**: a malicious user types adversarial text and we measure whether the LLM persona breaks. This is what PyRIT, Lakera Red, garak, Mindgard, HiddenLayer, and effectively every other red-team product on the market does.

It is also not how production agents actually get compromised.

The real-world attacks that have caused damage in the last 24 months — Bing Chat hijacked via webpage content, ChatGPT plugins owned via API responses, Anthropic / OpenAI email assistants compromised by injected email bodies, customer-support agents tricked into leaking via poisoned KB entries — are all variants of **indirect prompt injection** (Greshake et al., *"Not what you've signed up for"*, 2023). The attacker does not talk to the agent. The attacker plants payload in something the agent *fetches*: a webpage, a search result, a retrieved document, a database row, an incoming email, a Slack message in a channel the agent reads.

No major red-team framework simulates this. scenario can.

## 2. Why scenario is uniquely positioned

scenario already mediates the agent's full conversational context for testing. The framework sits between the agent and its inputs at test time. Every competitor in the market either:

- Targets **raw LLM endpoints** (PyRIT, garak) — no agent context, no tools.
- **Probes** the agent without simulating its environment (Lakera, HiddenLayer scanners).
- Runs **conversational** red-team only (GOAT, Crescendo, PAIR) — same user-channel limitation we're moving past.

scenario's adapter pattern means a test author already declares "this is my agent" with explicit tool boundaries. Extending that pattern so the framework can substitute *tool results* is incremental, not architectural. No competitor can do it without rebuilding their integration model.

## 3. Goal

Ship a red-team strategy that breaks agents through their **tool / data-fetch channel**, not their user channel. Concretely: a test author wraps their agent, declares which tools to make adversarial, and scenario generates poisoned tool results that try to compromise the agent in flight.

This is the third strategy in the lineup. After this lands, the matrix is:

| Strategy | Attack channel | What it catches |
|---|---|---|
| **Crescendo** | User messages | Slow-burn escalation, refusal softening over context |
| **GOAT** | User messages | Adaptive technique attacks (refusal suppression, hypothetical framing, encoding) |
| **IPI** *(new)* | Tool results / environment | Webpage/email/doc/RAG poisoning, real-world agent compromise |

Crescendo and GOAT are complementary attacks on the LLM persona. IPI attacks a different surface entirely. Together they are a defensible 3-strategy stack — not three flavors of the same thing.

## 4. Success metrics

**Ship-readiness:**

- IPI strategy implemented in Python (`python/scenario/_red_team/ipi.py`) and TypeScript (`javascript/src/agents/red-team/ipi-strategy.ts`) with parity.
- Public API: `scenario.RedTeamAgent.ipi(...)` / `scenario.redTeamIPI({...})`.
- Bank-demo integration test demonstrating compromise of an agent via a poisoned `lookup_account` or `read_email` tool result.

**Effectiveness:**

- On a hardened off-the-shelf agent (e.g., bank-demo with GPT-4o-mini), IPI achieves **≥ 40% attack success rate** in 5 turns across a battery of 10 objectives. Comparable to or better than GOAT against the *same agent* given equal LLM budget — we expect IPI to win because most agents aren't hardened against tool-result attacks at all.
- The strategy reliably distinguishes hardened from unhardened agents: a system-prompt-only defense should not stop it; an explicit "treat tool output as untrusted data" defense should.

**Adoption:**

- One published example (bank-demo or a new email-agent demo) that a new user can copy in under 15 minutes.
- Documented in the same README section as Crescendo / GOAT.

## 5. Non-goals

- **Replacing GOAT or Crescendo.** This is the third leg, not a competitor to the existing two.
- **Single-turn jailbreaking benchmarks** (AdvBench, HarmBench). IPI is about agent compromise, not chatbot persona breaking. We don't optimize for those leaderboards.
- **White-box attacks** (GCG, AutoDAN). Out of scope; scenario is black-box-only.
- **Auto-discovering tool boundaries.** The test author declares which tools to poison. We don't auto-instrument.
- **Multi-agent / agent-to-agent IPI.** A clear v2 once single-agent works.
- **Memory poisoning across runs.** Different attack surface, different spec.

## 6. Scope (v1)

**In scope:**

- A new `IPIStrategy` class implementing `RedTeamStrategy`.
- A new `IPIAdapter` wrapper that intercepts tool calls for a declared set of tool names and substitutes adversarial results generated by the attacker LLM.
- Adaptive payload generation: the attacker LLM sees the conversation so far and the tool call args, and tailors the injection to the objective.
- Reuse of the existing 0-10 scorer (`_score_last_response`) to grade whether the agent's response after the injection indicates compromise. Adds an additional "compromise type" labelling for telemetry: `data_leak`, `policy_violation`, `unauthorized_tool_call`, `instruction_followed`, `refused`.
- `state.last_injection_payload()` / `state.was_injected_tool_called(name)` helpers for assertion-style checks in user tests.
- Bank-demo example covering at least one of: account-data leak via poisoned account lookup, or policy bypass via poisoned policy doc.

**Out of scope (deferred):**

- Streaming / mid-tool-call injection (we inject at the tool-result boundary only).
- Image / file / non-text tool results (text-only for v1).
- MCP-server-based external corpus mode (a `scenario.mcp.AdversarialMCPServer`). Strong v2, requires standing up an MCP test harness.
- Auto-extracted payload library (use whatever the attacker LLM generates, no canned payloads).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| User adoption requires wrapping the adapter, which is invasive | Wrapper is 3 lines (`IPIAdapter(my_agent, poisoned_tools=[...])`). Document prominently with copy-paste example. |
| Test authors don't have tool boundaries exposed (agents that own their internal loop) | Document the limitation in the strategy docstring; suggest the MCP-mode v2 as the path for those agents. Bank-demo (Agno) works because Agno exposes tool calls in `response.messages`. |
| The attacker LLM generates injection payloads that look obviously synthetic and fail | Few-shot the attacker with realistic content shapes (email body, KB excerpt, search snippet) in the system prompt; provide `injection_format` parameter (`email`, `document`, `search_result`, `db_row`, `raw`) to anchor the framing. |
| Cost: every tool call triggers an LLM call to generate the payload | Cache payloads per `(tool_name, args_hash)` within a run. Document expected LLM-call count: `1 + n_poisoned_tool_calls` per turn vs GOAT's `1`. |
| Effectiveness varies wildly across agents — some never call the tools | The strategy will surface that empirically. Document: "if the agent doesn't call the poisoned tool, IPI can't compromise it — which is itself a useful test signal." |
| Confusion with general prompt injection | Doc explicitly contrasts: GOAT = direct prompt injection (user channel), IPI = indirect prompt injection (tool channel). Use Greshake's terminology. |

## 8. Milestones

| Milestone | Deliverable | Owner |
|---|---|---|
| **M0** — PRD + spec approved | This doc + `specs/feat-redteam-ipi.md` | Aryan |
| **M1** — Python `IPIStrategy` + `IPIAdapter` | Module, unit tests, `IPIStrategy` re-exported | Aryan |
| **M2** — `RedTeamAgent.ipi(...)` factory + integration | Public factory, end-to-end mock test | Aryan |
| **M3** — Bank-demo integration test | One real test against bank-demo, manual smoke run | Aryan |
| **M4** — TypeScript port | `ipi-strategy.ts`, `redTeamIPI`, tests, exports | Aryan |
| **M5** — Docs + announcement | README section + example + blog post draft | Aryan |

Each milestone is one PR. M1 and M2 can be one PR if M1 stays small. M4 is a separate PR mirroring the Python work — same pattern we used for TAP.

## 9. Decision: TAP

This PRD proposes IPI as the third strategy. The previously-started TAP work (`feat/redteam-tap-strategy`) becomes redundant under this proposal — IPI and TAP both target "what's the third strategy after Crescendo and GOAT" and IPI is the stronger answer (novel attack surface vs faithful-ish port of an existing paper). **Recommendation: revert the TAP branch when IPI lands.** Keep TAP's spec around as a "considered and rejected" artifact for the rationale trail.

## 10. Open questions

1. **Default `poisoned_tools` behavior** if the user wraps but declares nothing: error, or auto-target every tool the agent calls? *Lean: error with a helpful message — explicit > magic.*
2. **Multi-injection per turn**: if the agent makes multiple tool calls in one turn, inject all of them or only the first? *Lean: all, with a per-call cap to bound LLM cost.*
3. **Telemetry**: do we want a span for each injection event, or roll it into the existing red-team span? *Lean: new span `red_team.ipi_injection` with tool name, args hash, payload hash, follow-up score.*
4. **TS port timing**: ship M4 in the same PR as M1–M3 (matching the original strategy bring-up), or separate? *Lean: separate, mirrors the TAP PR pattern.*
