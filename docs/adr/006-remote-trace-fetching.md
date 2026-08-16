# ADR-006: Remote trace fetching for the judge

**Date:** 2026-08-15

**Status:** Accepted

## Context

When the agent under test runs behind an HTTP endpoint, the judge sees only the transcript. Tool calls, writes, and retrievals happen on the remote side and never reach the local span collector, so criteria about internal behavior are unverifiable. The LangWatch platform carried a private wrapper that fetched remote spans before evaluation; it fetched only the last turn's trace and paid a fixed wait on every judge call, and SDK users had nothing.

The runtime already has the two halves this needs: it opens one trace per conversation turn and stamps the trace id on every message, and the judge already renders spans from a `JudgeSpanCollector` into its `<opentelemetry_traces>` digest with progressive discovery for large traces.

## Decision

Trace propagation and remote fetching become SDK capabilities in both languages.

`AgentInput` exposes W3C propagation headers built from the active turn context (`propagation_headers` in Python, `propagationHeaders` in TypeScript). An HTTP adapter spreads them onto its outgoing request; the remote agent that adopts them writes its spans into the same trace the messages already reference.

Opt-in config enables fetching: Python `fetch_remote_traces: bool` and `trace_wait_timeout: float` seconds; TypeScript `fetchRemoteTraces?: boolean` and `traceWaitTimeoutMs?: number`. The judge fetches every distinct message trace id from `GET {LANGWATCH_ENDPOINT}/api/trace/{id}`, converts spans to the collector's shape, filters scenario infrastructure spans, dedupes against locally collected span ids, and feeds the same collector the digest already reads.

The judge runs in two phases, and only the second one touches remote traces. During the conversation the judge makes a decision call with two argument-free tools, `continue_test` and `make_verdict`: it decides whether the conversation has collected enough information, from the transcript and local spans only, with no remote fetching and no waiting. A `make_verdict` decision, the last turn, or an explicit judge step enters the verdict call, the only fetch site: the judge settle-waits once, polling every second under the shared timeout, until each trace holds at least one remote span (a fetched span that is not one of the scenario's own locally collected spans) and every fetched agent span's parent resolves within the fetched and locally collected spans (the scenario's own spans echoed back by the platform are exempt). A failed poll retries until the deadline instead of failing the trace. Ancestors finish and export after their descendants, so unresolved parents mean the trace is still arriving; span-count stability is deliberately not a settle signal, because ingestion arrives in chunks that can be tens of seconds apart. When the deadline expires with remote spans present, the judge keeps every collected span and additionally sees a synthetic `langwatch.span_collection.error` span marking the trace incomplete; with no remote spans at all, the synthetic span reports that nothing was collected. A voluntary verdict that comes back inconclusive continues the conversation, except when no trace of the run ever settled: then it is terminal, because more turns cannot produce the missing evidence. The judge prompt gains a rule that trace-dependent criteria go inconclusive, never passed on transcript claims alone.

## Rationale / Trade-offs

Placing the capability in the SDKs serves code-first users and lets the platform delete its wrapper instead of maintaining a fork of judge behavior. Waiting only at verdict keeps multi-turn conversations at full speed while guaranteeing every verdict is trace-informed, at the cost of at most one extra judge call per run. Parent resolution detects missing ancestors but not missing leaf subtrees, so it is a strong heuristic, not a completeness proof; the deadline bounds the wait, and the synthetic error span plus the inconclusive rule covers incomplete and missing traces.

## Consequences

Blackbox HTTP agents become judgeable on real behavior. Verdicts wait for trace ingestion on the final turn, bounded by the configured timeout. The remote agent must report to the same LangWatch project the fetch reads from. The platform passes a per-project wait budget computed from its own ingest statistics.

## References

- Spec: `specs/remote-trace-fetching.feature`
- Platform ADR: langwatch `dev/docs/adr/097-scenario-remote-trace-judging.md`
- Review draft: https://nexus.langwatch.ai/wiki/scenario-remote-traces-adr
