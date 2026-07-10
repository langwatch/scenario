# ADR-005: OpenCodeAgentAdapter — drive opencode via @opencode-ai/sdk as a scenario agent (#5001)

**Date:** 2026-06-23

**Status:** Accepted

**Companion docs:** [ADR-001 Concurrency](./001-scenario-concurrency-model.md) · [ADR-002 Voice Provider State](./002-voice-provider-state.md) · [ADR-003 Voice Internal Design](./003-voice-internal-design.md) · [ADR-004 ffmpeg Bundling](./004-ffmpeg-bundling.md)

_This is an Engineering Design Record. Committed at repo-root `docs/adr/005-opencode-agent-adapter.md` alongside ADR-001..004 (not under `javascript/docs/`)._

## Why this doc exists

Issue #5001 requests a scenario adapter for [opencode](https://opencode.ai/), an
open-source AI coding agent. The adapter lets authors run scenario tests that drive
opencode as the agent under test — the same way PR #687 introduced
`ClaudeCodeAgentAdapter` for the Claude Code CLI. Several non-obvious design calls
were made during a `/decide` + devils-advocate pass:

- The class shape diverges from the original issue spec's skeleton (which assumed a
  non-existent API).
- The testability seam is dependency injection, NOT `vi.mock` of the SDK (rejected
  after analysis).
- The payload strategy is new-messages-only, NOT full-history (deliberate divergence
  from #687's first-turn behavior, for reasons specific to opencode's server-side
  state model).
- Error handling requires two independent checks per call (transport and semantic).
- Several concurrency, teardown, and empty-response edge cases were identified and
  hardened against before implementation began.

This record makes those calls auditable so future contributors understand what was
decided and why.

## Context

### The original spec skeleton was wrong

The issue spec included a bare-factory skeleton modeled on a `langwatch/langwatch`
helper. That helper accessed a `ScenarioExecutionStateLike.lastNewUserMessageStr()`
method that **does not exist** on scenario's TypeScript `AgentInput`
(`javascript/src/domain/agents/index.ts:54-83`). The existing `AgentInput` exposes
`messages: ModelMessage[]` and `newMessages: ModelMessage[]` — the adapter must
derive the prompt text from those arrays itself.

### The authoritative in-repo precedent is PR #687

`ClaudeCodeAgentAdapter` (PR #687, open at time of writing) is the correct
structural template:
- `class ClaudeCodeAgentAdapter extends AgentAdapter` with `role = AgentRole.AGENT`
  and a named `sessions = new Map<string, string>()`.
- A lowercase `claudeCodeAgent(config)` factory as the public entry point.
- Session-id tracking for stateful multi-turn continuation.

The OpenCode adapter mirrors this shape directly.

### The SDK transport: `@opencode-ai/sdk@1.17.9`

`createOpencode(options?)` spawns the `opencode` binary's HTTP server
(`cross-spawn('opencode', ['serve', ...])`) and returns
`Promise<{ client: OpencodeClient; server: { url: string; close(): void } }>`.
The completion primitive is `client.session.prompt({ path: { id }, body: { model, parts } })`,
which resolves only AFTER the assistant finishes — no SSE event stream needed.
Response shape: `{ data: { info: AssistantMessage; parts: Part[] }, error }`.
Assistant text lives in `result.data.parts` (filter `type === "text"`, skip
`ignored === true`). `result.data.info` is metadata, not the reply text.

## Decision

### 1. Shape: class + lowercase factory

```text
javascript/src/agents/opencode/
  opencode-agent.adapter.ts    — class OpenCodeAgentAdapter + helpers
  index.ts                     — barrel + openCodeAgent(config) factory
javascript/src/agents/__tests__/opencode-adapter.test.ts
```

`class OpenCodeAgentAdapter extends AgentAdapter` with `role = AgentRole.AGENT` and
`name = "OpenCodeAgent"`. A `openCodeAgent(config)` factory is exported as the
recommended user-facing constructor. This mirrors PR #687's `ClaudeCodeAgentAdapter`
shape and is wired into `javascript/src/agents/index.ts` via `export * from "./opencode"`.

### 2. Config: `model` is REQUIRED (product choice, not SDK constraint)

```typescript
interface OpenCodeAgentAdapterConfig {
  model: { providerID: string; modelID: string };  // REQUIRED
  workingDirectory?: string;
  timeout?: number;
  logger?: OpenCodeLogger;
  client?: OpencodeClient;  // injection seam — see §4
}
```

`model` is **required** as a product decision for reproducible, explicit model
selection in evaluations. The `@opencode-ai/sdk` `model` field is itself optional
(the server has a default), but scenario evaluations must be deterministic and
auditable — an implicit default breaks that guarantee. Recommended starting value:
`{ providerID: "openai", modelID: "gpt-5.4-mini" }`.

### 3. Session-per-threadId: create once, reuse after

```typescript
private sessions = new Map<string, string>(); // threadId → sessionId
```

On a thread's first call: `client.session.create({ body: { title: \`scenario:${threadId}\` } })`.
On all subsequent calls for that thread: reuse the stored `sessionId`. This is the
genuinely new pattern relative to #687 — opencode exposes a first-class server-side
session object (analogous to `claude --resume`) rather than a CLI flag. One
`session.create` per thread over the adapter's lifetime satisfies AC-2.

### 4. Testability seam: inject `OpencodeClient`, do NOT `vi.mock` the SDK

Config accepts an optional `client?: OpencodeClient`. When provided, the adapter
uses it directly and does not own the server. When absent, the adapter lazily calls
`createOpencode()` (memoized as a `Promise`, see §9) and owns the resulting server.

**Why injection over `vi.mock`:** the realtime adapter precedent
(`javascript/src/agents/realtime/realtime-agent.adapter.ts:49`) injects its live
`RealtimeSession` object — it does not mock the SDK module. Injecting a typed fake
`OpencodeClient` means the fake must satisfy the REAL `OpencodeClient` interface, so
a breaking SDK envelope change fails the fake's TypeScript compilation and surfaces
immediately. A `vi.mock` of `@opencode-ai/sdk` constructs a fiction — tests pass as
long as the mock matches our beliefs about the SDK, NOT as long as the SDK stays
compatible with our code.

PR #687 was forced into `vi.mock` because it shells out via `child_process` with no
injection seam. opencode provides a first-class typed client; we take the better seam.

### 5. Payload: new messages only, NOT full-history flatten

Each `call` sends only `input.newMessages` (USER-role messages from the delta), NOT
`input.messages` (the full history). This is a deliberate divergence from PR #687's
first-turn behavior.

**Why:** #687 sends `input.messages` (full history) on the first turn because the
`claude -p` CLI is stateless — the server holds nothing, so the full transcript must
be serialized into the prompt. opencode holds server-side session state. Re-feeding
the agent's own prior replies as user text into a stateful session double-seeds
context and produces degenerate or truncated replies. The branch on session existence
is ONLY for `session.create` vs. reuse — never for payload composition.

Session-injected non-user messages (e.g. a canned `scenario.agent(...)` turn placed
before the first real user message) are not replayed into the opencode session. This
is the same boundary the realtime adapter relies on: server-side state is the source
of truth for the agent's context, not the scenario transcript.

If `extractNewUserText(input.newMessages)` resolves to an empty string (no user
messages in the delta), the adapter throws a clear error:

> "opencode is prompt-driven and cannot open a conversation on its own; ensure a
> `user()` step precedes `agent()` in the script."

### 6. Error handling: two independent layers per call

A single `client.session.prompt(...)` call requires TWO error checks:

1. **Transport error** (`result.error` is set): HTTP-level or SDK-level failure.
   Throw a friendly named error. If this was a continuation turn (a stored
   `sessionId` existed), evict it from `sessions` so the next call recreates — this
   mirrors #687's stale `--resume` eviction.

2. **Semantic error** (`result.data.info?.error` is set): opencode returns HTTP 200
   for model-level failures (`ProviderAuthError`, `MessageOutputLengthError`,
   `MessageAbortedError`, `ApiError`, `UnknownError`). A 200 with a semantic error
   carries zero text parts. Both fields must be checked; checking only `result.error`
   silently returns an empty response on semantic failures.

### 7. Never emit a silent empty assistant turn

`partsToText(parts)` filters `type === "text"` parts (skipping `ignored === true`)
and concatenates. It does NOT throw on non-text parts (tool calls, step-start,
step-finish, reasoning, etc.) — a real opencode reply interleaves these with text
and they must be skipped cleanly (AC-6).

Three outcomes after filtering:

| Condition | Action |
|-----------|--------|
| Non-empty text after filtering | Return it — normal path |
| Empty text but non-text parts present | Return a readable fallback render (e.g. `[tool: <name>]`) — AC-4 forbids silent empty turns |
| No parts at all | Throw — the response is structurally invalid |

AC-4 explicitly forbids empty or truncated responses, so the adapter must not
manufacture one under any condition.

### 8. Concurrency: memoize the server-start PROMISE

```typescript
private serverPromise: Promise<{ client: OpencodeClient; server: { url: string; close(): void } }> | null = null;
```

The memoized value is the **Promise**, not the resolved value. Two threads' concurrent
first calls both await the same Promise and therefore cannot spawn two `opencode serve`
processes. Resolving the memoized value and then memoizing it would create a race
window between `createOpencode()` returning and the resolved value being stored.

### 9. Timeout: AbortSignal, not Promise.race

`timeout?: number` is forwarded to `client.session.prompt(...)` as an `AbortSignal`
(via `AbortSignal.timeout(ms)`), NOT implemented as `Promise.race`. `Promise.race`
abandons the in-flight request without actually cancelling it — the opencode server
continues processing. An `AbortSignal` propagates the cancel to the HTTP layer so the
request is actually aborted.

### 10. Teardown

```typescript
async close(): Promise<void>
```

If the adapter spawned its own server (i.e., `config.client` was absent and
`serverPromise` was set): awaits the Promise and calls `server.close()`. If a client
was injected, `close()` shuts nothing down — the injector owns its server. Document
calling `adapter.close()` in `afterAll` (mirrors `session.close()` in the realtime
adapter).

`close()` is **terminal** either way: it marks the adapter closed synchronously on
entry, and any `call(...)` issued afterwards rejects with a clear closed-adapter
error instead of racing the torn-down (or relinquished) server into an opaque
transport failure. Calls already in flight when `close()` runs remain the caller's
teardown contract to sequence (await the scenario, then close); an overlapping call
fails loudly at the transport layer rather than corrupting session state.

## Alternatives considered

### `vi.mock("@opencode-ai/sdk")` for tests

The jest/vitest module-mock approach was the natural first impulse, and how PR #687
is tested (unavoidably — it shells `child_process`). Rejected here because opencode
provides a typed `OpencodeClient` that can be satisfied by a fake implementation
that TypeScript checks. A module mock is a fiction; a typed fake is a contract. The
compile-time check on the fake provides exactly the regression protection we want
when the SDK's response envelope changes.

### Full-history flatten on every turn (matching #687)

Rejected for stateful sessions. #687's full-history flatten is a workaround for a
stateless CLI transport. opencode's `session.prompt` continues an existing session —
re-sending prior agent replies as user text produces degenerate context. The divergence
is intentional and documented; it is not a defect to be reconciled with #687.

### Bare factory function (original spec skeleton)

Rejected. The spec skeleton was modeled on a `langwatch/langwatch` helper that assumed
`ScenarioExecutionStateLike.lastNewUserMessageStr()` — a method that does not exist on
scenario's `AgentInput`. Beyond the missing API, the class shape is correct here:
session state (`sessions` map, `serverPromise`) requires instance scope. A bare factory
returning a closure could hold the same state, but the class shape is the established
in-repo pattern (PR #687, realtime adapter) and produces better tooling and error traces.

### Single error check on `result.error`

Rejected. The SDK's `throwOnError` defaults to `false` and the response style is
`"fields"`, which means HTTP-200 semantic errors populate `result.data.info.error`
with a non-null union (`ProviderAuthError | MessageOutputLengthError | ...`) while
`result.error` is `undefined`. Checking only `result.error` silently returns an
empty-text response for the semantic-error case, violating AC-4.

## Consequences / open tensions

### AC-4 (live multi-turn run) is unprovable in CI

`createOpencode()` shells out to the `opencode` binary, which is absent from CI
runners. The integration test for AC-4 is env-gated (`RUN_OPENCODE_E2E=1`) and is
skipped in CI. AC-4 evidence must be a manual 3-run proof (logs or screenshot)
attached to the PR — the same shape as #687's `e2e-proof.png`. This is a structural
limitation of adapters that wrap external binaries, not a deficiency of the adapter
design.

### The live e2e is flaky: `session.prompt` intermittently stalls

Measured over 17 consecutive live runs on one machine: **13 passed, 4 stalled.** A
passing run completes the whole two-turn scenario in 11–33s; a stalled run makes no
progress and is only ended by a timeout. The stall is inside `session.prompt` — the
adapter has issued the request and the opencode server never answers.

Ruled out, each checked directly at the time of a stall cluster: provider rate
limiting (`GET /v1/models` and a `gpt-5.4-mini` completion both returned 200 in
under 1.5s, with a full quota), a slow provider (a bare `opencode run -m
openai/gpt-5.4-mini` answered in 4–6s, three times), a zombie server holding port
4096 (no matching process, port free), and accumulated local session state. It also
predates the adapter's `timeout`: the first observed stall ran with no timeout
configured. It did not reproduce while instrumented, so the stalling turn is not
identified — both turns are equally suspect.

Two consequences. First, `timeout` is not optional for the e2e: without it, vitest's
own test timeout kills the test body, the `finally` never runs, and the temp working
dir and the spawned server both leak — the leaked server then holds port 4096 and
fails the *next* run fast. With `timeout` set below the vitest timeout, the stall
surfaces as `[OpenCodeAgent] TimeoutError` and teardown still runs. Second, AC-4's
proof is a **majority of live runs**, not a clean sweep; anyone re-running it should
expect roughly one stall in four and should not read a single red run as a
regression in this adapter.

### Unit tests prove parsing/branching, not lifecycle

The injected-fake unit tests (AC-1, AC-2, AC-3, AC-6) verify session mapping,
payload extraction, error branching, and text-part filtering against the real
`OpencodeClient` interface. They prove nothing about the real `createOpencode()`
spawn, the binary lifecycle, or true multi-turn continuation — only the live AC-4
integration test does that.

### Agent-first scenarios unsupported

opencode requires a user message to begin a turn (`session.prompt` needs a non-empty
`parts` array). Like #687, the adapter throws a clear error if no user message is
present in the delta rather than silently calling `session.prompt` with an empty
body. Unlike the realtime adapter (which can issue `response.create` to make the
agent speak first), this is a hard transport constraint of the prompt-driven model.

### `model` required-ness is a product call, not enforced by the SDK

The `@opencode-ai/sdk` `model` field is optional — the opencode server applies its
own default. Making `model` required in `OpenCodeAgentAdapterConfig` is a scenario
product decision: evaluations need an explicit, pinned model for reproducibility. If
future opencode versions expose a stable, documented server default, this constraint
could be relaxed — but that is its own decision.

### Server ownership responsibility falls to the caller for injected clients

When `client` is injected, `close()` makes no attempt to shut down the server (it
still marks the adapter closed — post-close calls reject). The caller is responsible
for calling `server.close()` in their own `afterAll`. This mirrors the realtime
adapter's ownership model for injected sessions, but it is easy to miss. Examples in
the docs (AC-5) must show the correct `afterAll` teardown for both cases.

### The owned server is unauthenticated, on a fixed loopback port

`createOpencode()` with no options binds `127.0.0.1:4096`. Loopback-only, so it is not
network-exposed — but `ServerOptions` offers no auth token, and this adapter exposes no
`port`/`hostname` override. While the server is alive, any other local process or user
on the same host can reach it and drive the same coding-agent session against
`workingDirectory`. On a shared CI runner or devbox, treat `workingDirectory` as
readable and writable by any co-tenant process. This is inherent to `opencode serve`,
not a defect of this adapter, but callers must know it.

Corollary for tests: opencode is **tool-bearing** (shell + file read/write) and is not
constrained to the prompts it is given. The live e2e therefore runs in an `fs.mkdtemp`
directory, never `process.cwd()` — the repo working tree holds a gitignored `.env` with
real provider keys, and a self-directed read of that file would flow back as assistant
text into the judge prompt and CI logs.

### Spawn failure is terminal, and forwards the child's raw output

`ensureClient()` memoizes with `serverPromise ??= createOpencode()`, so a **rejected**
spawn is never evicted — unlike `resolveSessionId`, which evicts a failed `create` so
the next turn retries. A transient spawn failure (port contention, slow binary startup)
therefore poisons the adapter for its lifetime. This asymmetry is deliberate — a missing
binary will not fix itself, and retry-spam is worse — but it means a caller who shares
one adapter across a whole test file loses every subsequent scenario.

Relatedly, when the child exits non-zero the SDK rejects with `Server exited with code
N\nServer output: <raw stdout+stderr>`, which `ensureClient()` propagates verbatim. The
adapter's own `describeError()` never touches this path, so its careful field-scoping
(`.name`, `.data.message` only) does not apply. Whether `opencode serve`'s crash output
can contain secrets is a property of that binary, not of this repo — an open gap, not a
confirmed leak.

### A server restart mid-run silently invalidates every session id

Session ids live server-side. If the owned server dies between turns and a later call
reconnects to a fresh one, every id in the `sessions` map is stale. The adapter cannot
today distinguish "this session is gone because the server restarted" from "this session
id was bad": the prompt-error path evicts the one session and recreates it, without
flushing the map or resetting `serverPromise`. Classifying connection-level failures
(`ECONNREFUSED`, connection reset) separately would let the adapter flush both. Not
reachable in current usage — the server is spawned once per adapter and torn down in
`close()` — so it is recorded here rather than solved speculatively.
