import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  ModelMessage,
  ToolSet,
  Tool,
  tool,
  stepCountIs,
  hasToolCall,
} from "ai";
import { z } from "zod/v4";

const DISCOVERY_TOOL_NAMES = new Set(["expand_trace", "grep_trace"]);

/**
 * Stringifies a tool result's `output` field into something safe to embed in
 * a plain-text assistant message.
 */
function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const maybeValue = (output as { value?: unknown }).value;
    if (typeof maybeValue === "string") return maybeValue;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

/**
 * Rewrites the message history so every discovery cycle
 * (assistant tool-call for expand_trace/grep_trace → tool-result) is
 * collapsed into a single plain-text assistant message recounting what
 * the judge called and what came back.
 *
 * Two reasons this matters before a forced verdict:
 *  1. Anthropic rejects calls whose history references tools that aren't
 *     in the current `tools` array. Plain-text history lets us safely strip
 *     expand_trace/grep_trace from the tool set.
 *  2. With the discovery tools gone from both history and tool set, the
 *     model physically cannot emit them in the forced response — no more
 *     leaks past `parseToolCalls`.
 *
 * Messages without discovery tool content pass through unchanged, so
 * nothing else (criteria, transcripts, non-discovery tool calls) is
 * affected.
 */
function collapseDiscoveryHistory(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = msg.content as Array<Record<string, unknown>>;
      const discoveryCalls = parts.filter(
        (p) =>
          p?.type === "tool-call" &&
          typeof p.toolName === "string" &&
          DISCOVERY_TOOL_NAMES.has(p.toolName)
      );

      if (discoveryCalls.length > 0) {
        // Collect all consecutive tool-role messages so we catch results even
        // when the AI SDK emits them across multiple separate messages.
        const resultParts: Array<Record<string, unknown>> = [];
        let toolMsgCount = 0;
        for (let k = i + 1; k < messages.length; k++) {
          const next = messages[k];
          if (next.role === "tool" && Array.isArray(next.content)) {
            for (const p of next.content as Array<Record<string, unknown>>) {
              if (p?.type === "tool-result") resultParts.push(p);
            }
            toolMsgCount++;
          } else {
            break;
          }
        }

        const lines: string[] = [];
        for (const p of parts) {
          if (p?.type === "text" && typeof p.text === "string") {
            lines.push(p.text);
          } else if (
            p?.type === "tool-call" &&
            typeof p.toolName === "string" &&
            DISCOVERY_TOOL_NAMES.has(p.toolName)
          ) {
            const match = resultParts.find(
              (r) => r.toolCallId === p.toolCallId
            );
            let input: string;
            try {
              input = JSON.stringify(p.input);
            } catch {
              input = String(p.input);
            }
            const body = match
              ? stringifyToolOutput(match.output)
              : "(no result captured)";
            lines.push(
              `[Called ${String(p.toolName)} with ${input}]\n${body}`
            );
          }
        }

        out.push({
          role: "assistant",
          content: lines.join("\n\n"),
        });

        i += toolMsgCount;
        continue;
      }
    }

    out.push(msg);
  }

  return out;
}

import { estimateTokens, DEFAULT_TOKEN_THRESHOLD } from "./estimate-tokens";
import { JudgeResult } from "./interfaces";
import { judgeSpanCollector, JudgeSpanCollector } from "./judge-span-collector";
import { judgeSpanDigestFormatter } from "./judge-span-digest-formatter";
import { JudgeUtils } from "./judge-utils";
import { expandTrace, grepTrace } from "./trace-tools";
import { getProjectConfig } from "../../config";
import {
  AgentInput,
  JudgeAgentAdapter,
  AgentRole,
  DEFAULT_MAX_TURNS,
  DEFAULT_TRACE_WAIT_TIMEOUT_MS,
} from "../../domain";
import { modelSchema } from "../../domain/core/schemas/model.schema";
import {
  collectMessageTraceIds,
  remoteTraceFetcher,
  RemoteTraceFetcher,
} from "../../tracing/remote-trace-fetcher";
import { Logger } from "../../utils/logger";
import { resolveVoiceConfig } from "../../voice/config";
import { prepareJudgeInput } from "../../voice/judge-stt";
import { createLLMInvoker } from "../llm-invoker.factory";
import {
  TestingAgentConfig,
  FinishTestArgs,
  InvokeLLMParams,
  InvokeLLMResult,
} from "../types";
import { criterionToParamName } from "../utils";


/**
 * Configuration for the judge agent.
 */
export interface JudgeAgentConfig extends TestingAgentConfig {
  /**
   * A custom system prompt to override the default behavior of the judge.
   */
  systemPrompt?: string;
  /**
   * The criteria that the judge will use to evaluate the conversation.
   */
  criteria?: string[];
  /**
   * Optional span collector for telemetry. Defaults to global singleton.
   */
  spanCollector?: JudgeSpanCollector;
  /**
   * Optional remote trace fetcher, used when `fetchRemoteTraces` is enabled
   * on the scenario or project config. Defaults to global singleton.
   */
  traceFetcher?: RemoteTraceFetcher;
  /**
   * Token threshold for switching to structure-only trace rendering.
   * When the full trace digest exceeds this estimated token count,
   * the judge receives a structure-only view with expand_trace and
   * grep_trace tools for progressive discovery.
   *
   * @default 8192
   */
  tokenThreshold?: number;
  /**
   * Maximum number of tool-calling steps for progressive trace discovery.
   * Only applies when the trace exceeds the token threshold.
   *
   * @default 10
   */
  maxDiscoverySteps?: number;

  // ----------------------------------------------------------------- §4.3 voice
  /**
   * Whether to pass audio content to the judge model.
   *
   * - `true` / `false` — explicit; overrides auto-detection.
   * - `null` (default) — auto-detect: `true` when the conversation has audio AND
   *   the judge model is known to support multimodal input.
   *
   * Set `includeAudio: false` as a cost-reduction escape hatch on multimodal
   * models when audio evaluation is not needed.
   */
  includeAudio?: boolean | null;

  /**
   * Whether to include a structured voice timeline in the judge input.
   *
   * - `true` / `false` — explicit.
   * - `null` (default) — auto: `true` when the conversation has audio.
   */
  includeTimeline?: boolean | null;

  /**
   * Whether to include OTel / LangWatch trace spans in the judge input.
   *
   * - `true` / `false` — explicit.
   * - `null` (default) — auto: `true` when LangWatch / OTel is configured.
   */
  includeTraces?: boolean | null;
}

/**
 * Rule appended to the verdict system prompt's rules section when remote
 * trace fetching is enabled. The Python SDK uses the same text; keep them in
 * sync.
 */
const REMOTE_TRACE_JUDGING_RULE =
  "Criteria about the agent's internal behavior (tool calls, database writes, API calls, retrievals) must be verified against the <opentelemetry_traces> section, not against claims in the transcript. If a span named langwatch.span_collection.error is present, read its reason: when no agent spans arrived, mark criteria that depend on internal behavior as inconclusive, never passed. When the trace is incomplete, criteria proven by the spans that are present may pass, and criteria whose evidence is missing stay inconclusive. Criteria about the conversation itself are unaffected by missing traces: judge them from the transcript as normal. Never mark internal-behavior criteria as passed based on the transcript alone.";

/**
 * Appended to a custom system prompt on decision calls, so custom judge
 * personas still drive the argument-free decision tools correctly. The
 * Python SDK uses the same text; keep them in sync.
 */
const DECISION_PHASE_RULE =
  "In this step, only decide whether the conversation has collected enough information to evaluate the criteria: call make_verdict when it has, or continue_test to let the conversation play out. Do not decide whether the criteria pass or fail now: that evaluation happens in a separate step after the conversation ends.";

/**
 * Appended to the decision system prompt when remote trace fetching is
 * enabled. The Python SDK uses the same text; keep them in sync.
 */
const REMOTE_TRACE_DECISION_RULE =
  "The agent's execution traces are fetched and verified at the verdict, after the conversation ends; they are not part of this decision. Do not continue the conversation only to wait for trace evidence, and do not end it early to see traces sooner.";

function buildCriteriaList(criteria: string[]): string {
  return (
    criteria?.map((criterion, idx) => `${idx + 1}. ${criterion}`).join("\n") ||
    "No criteria provided"
  );
}

/**
 * System prompt for the decision phase. The decision deliberately carries no
 * verdict vocabulary: the judge is told NOT to decide pass or fail yet, so
 * nothing in this call can pre-commit it to an outcome before the verdict
 * phase sees the full evidence.
 */
function buildDecisionSystemPrompt({
  criteria,
  description,
  fetchRemoteTraces,
}: {
  criteria: string[];
  description: string;
  fetchRemoteTraces: boolean;
}): string {
  const remoteRule = fetchRemoteTraces
    ? `\n- ${REMOTE_TRACE_DECISION_RULE}`
    : "";

  return `
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to decide if it has collected enough information to evaluate the agent under test.
</role>

<goal>
Your goal is to decide if the conversation has collected enough information to evaluate the criteria, or if it should continue for longer. Do not decide whether the criteria pass or fail now: that evaluation happens in a separate step after the conversation ends. If enough information has been collected, call the make_verdict tool; if not, call the continue_test tool to let the next step play out.
</goal>

<scenario>
${description}
</scenario>

<criteria>
${buildCriteriaList(criteria)}
</criteria>

<rules>
- Call make_verdict as soon as the agent has clearly broken one of the "do not" or "should not" criteria; more conversation cannot repair a violation.
- Scenario simulations exist to exercise multi-turn conversations: while the conversation is still short, lean towards continuing, and end it only when more turns would clearly add no information for the criteria.${remoteRule}
</rules>
`.trim();
}

/** System prompt for the verdict phase. */
function buildVerdictSystemPrompt({
  criteria,
  description,
  fetchRemoteTraces,
}: {
  criteria: string[];
  description: string;
  fetchRemoteTraces: boolean;
}): string {
  const remoteTraceRule = fetchRemoteTraces
    ? `\n- ${REMOTE_TRACE_JUDGING_RULE}`
    : "";

  return `
<role>
You are an LLM as a judge delivering the final verdict on a simulated conversation, determining if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to deliver the final verdict of the scenario below with the finish_test tool, evaluating each criterion independently against the conversation and the collected evidence.
</goal>

<scenario>
${description}
</scenario>

<criteria>
${buildCriteriaList(criteria)}
</criteria>

<rules>
- Be strict: a criterion passes only when the conversation or the collected evidence clearly shows it was met.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
- When the evidence for a criterion is not definitive, mark that criterion inconclusive rather than guessing; an inconclusive verdict is acceptable${remoteTraceRule}
</rules>
`.trim();
}

/**
 * Builds the user-message content the judge evaluates: the conversation
 * transcript, the OpenTelemetry trace digest, and any additional context.
 * Shared between the initial judge call and the two-phase re-invocation,
 * which rebuilds the content with an updated digest.
 */
function buildJudgeContent({
  transcript,
  digest,
  additionalContextSection,
}: {
  transcript: string;
  digest: string;
  additionalContextSection: string;
}): string {
  return `
    <transcript>
    ${transcript}
    </transcript>
    <opentelemetry_traces>
    ${digest}
    </opentelemetry_traces>${additionalContextSection}
    `;
}

function buildContinueTestTool(): Tool {
  return tool({
    description: "Continue the test with the next step",
    inputSchema: z.object({}),
  });
}

/**
 * The decision phase's transition tool. Argument-free on purpose: a
 * reasoning field would push the judge to pre-commit to pass or fail before
 * the evidence is complete, and the text itself is wasted tokens for a
 * binary transition.
 */
function buildMakeVerdictTool(): Tool {
  return tool({
    description:
      "The conversation has collected enough information to evaluate the criteria. End the conversation and move to the verdict.",
    inputSchema: z.object({}),
  });
}

/**
 * The verdict phase's one-shot extension tool. Offered only when the remote
 * traces are still incomplete after the settle-wait, and withdrawn after one
 * use: the second verdict call must decide on the evidence it has.
 */
function buildWaitForTracesTool(): Tool {
  return tool({
    description:
      "The remote trace evidence is still incomplete and the missing spans are essential for the verdict. Wait one more period for them to arrive. Available once: after this wait the verdict must be delivered on the evidence at hand. Only call this when a criterion genuinely depends on the missing spans; otherwise deliver the verdict now.",
    inputSchema: z.object({}),
  });
}

function buildFinishTestTool(criteria: string[]): Tool {
  const criteriaNames = criteria.map(criterionToParamName);

  return tool({
    description: "Complete the test with a final verdict",
    inputSchema: z.object({
      criteria: z
        .object(
          Object.fromEntries(
            criteriaNames.map((name, idx) => [
              name,
              z.enum(["true", "false", "inconclusive"]).describe(criteria[idx]),
            ])
          )
        )
        .strict()
        .describe("Strict verdict for each criterion"),
      reasoning: z
        .string()
        .describe("Explanation of what the final verdict should be"),
      verdict: z
        .enum(["success", "failure", "inconclusive"])
        .describe("The final verdict of the test"),
    }),
  });
}

/**
 * Builds the expand_trace and grep_trace tools for progressive trace discovery.
 * These tools allow the judge to drill into large traces on demand rather than
 * receiving the entire trace content upfront.
 *
 * @param spans - The full array of ReadableSpan objects for the trace
 * @returns ToolSet containing expand_trace and grep_trace tools
 */
function buildProgressiveDiscoveryTools(spans: ReadableSpan[]): ToolSet {
  return {
    expand_trace: tool({
      description:
        "Expand one or more spans to see their full details (attributes, events, content). Use the span ID shown in brackets in the trace skeleton.",
      inputSchema: z.object({
        span_ids: z
          .array(z.string())
          .describe("Span IDs (or 8-char prefixes) to expand"),
      }),
      execute: async ({ span_ids }) => {
        return expandTrace(spans, span_ids);
      },
    }),
    grep_trace: tool({
      description:
        "Search across all span attributes, events, and content for a pattern (case-insensitive). Returns matching spans with context.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("Search pattern (case-insensitive)"),
      }),
      execute: async ({ pattern }) => {
        return grepTrace(spans, pattern);
      },
    }),
  };
}

/**
 * Agent that evaluates conversations against success criteria.
 *
 * This is the default judge agent that is used if no judge agent is provided.
 * It is a simple agent that uses function calling to make structured decisions
 * and provides detailed reasoning for its verdicts.
 *
 * @param cfg {JudgeAgentConfig} Configuration for the judge agent.
 */
export class JudgeAgent extends JudgeAgentAdapter {
  private logger = new Logger("JudgeAgent");
  private readonly spanCollector: JudgeSpanCollector;
  private readonly tokenThreshold: number;
  private readonly maxDiscoverySteps: number;
  role: AgentRole = AgentRole.JUDGE;
  criteria: string[];

  /**
   * LLM invocation function. Can be overridden to customize LLM behavior.
   */
  invokeLLM: (params: InvokeLLMParams) => Promise<InvokeLLMResult> =
    createLLMInvoker(this.logger);

  constructor(private readonly cfg: JudgeAgentConfig) {
    super();
    this.criteria = cfg.criteria ?? [];
    this.spanCollector = cfg.spanCollector ?? judgeSpanCollector;
    this.tokenThreshold = cfg.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    this.maxDiscoverySteps = cfg.maxDiscoverySteps ?? 10;
  }

  // ----------------------------------------------------------------- §4.3 voice

  /**
   * Model substrings that indicate multimodal (audio-capable) support.
   * Mirrors `python/scenario/judge_agent.py:_AUDIO_CAPABLE_MODEL_SUBSTRINGS`.
   */
  static readonly AUDIO_CAPABLE_MODEL_SUBSTRINGS: readonly string[] = [
    "gpt-4o",
    "gemini-2.5",
    "gemini-2.0-flash",
  ];

  /**
   * Extract a string identifier from the configured model for substring matching.
   *
   * `LanguageModel` is `GlobalProviderModelId | LanguageModelV3 | LanguageModelV2`.
   * `GlobalProviderModelId` resolves to a string literal; provider objects expose
   * a `modelId` property. We handle both shapes.
   */
  private modelString(): string {
    const model = this.cfg.model;
    if (!model) return "";
    if (typeof model === "string") return model.toLowerCase();
    // LanguageModelV3 / LanguageModelV2 objects expose `modelId`.
    const obj = model as { modelId?: string; provider?: string };
    const parts = [obj.provider ?? "", obj.modelId ?? ""].filter(Boolean);
    return parts.join("/").toLowerCase();
  }

  /**
   * Whether the configured judge model can ingest raw audio.
   * Determined by checking model name substrings.
   */
  modelSupportsAudio(): boolean {
    const m = this.modelString();
    return JudgeAgent.AUDIO_CAPABLE_MODEL_SUBSTRINGS.some((s) => m.includes(s));
  }

  /**
   * Whether any message in `messages` contains an audio content part.
   *
   * Recognizes the canonical AI-SDK `file` audio part
   * (`{ type: "file", mediaType: "audio/*" }`, EDR §4.2 — the single
   * in-message format the voice subsystem now produces) and, for
   * adapter-edge tolerance, the legacy OpenAI `input_audio` / `audio`
   * conventions.
   *
   * Port of `python/scenario/judge_agent.py:_conversation_has_audio`.
   */
  static conversationHasAudio(messages: readonly unknown[]): boolean {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const content = m["content"];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (
          p["type"] === "file" &&
          typeof p["mediaType"] === "string" &&
          (p["mediaType"] as string).startsWith("audio/")
        ) {
          return true;
        }
        if (p["type"] === "input_audio" || p["type"] === "audio") return true;
      }
    }
    return false;
  }

  /**
   * Resolves `include_audio` for this evaluation:
   * - Explicit `true`/`false` wins.
   * - `null` (default): `true` only when conversation has audio AND the judge
   *   model is known to be multimodal.
   *
   * Port of `python/scenario/judge_agent.py:effective_include_audio`.
   */
  effectiveIncludeAudio(conversationHasAudio: boolean): boolean {
    const explicit = this.cfg.includeAudio;
    if (explicit !== null && explicit !== undefined) {
      return explicit && conversationHasAudio;
    }
    return conversationHasAudio && this.modelSupportsAudio();
  }

  /**
   * Resolves `include_timeline` for this evaluation.
   * Defaults to `true` for voice conversations (auto-detect = conversation has audio).
   *
   * Port of `python/scenario/judge_agent.py:effective_include_timeline`.
   */
  effectiveIncludeTimeline(conversationHasAudio: boolean): boolean {
    const explicit = this.cfg.includeTimeline;
    if (explicit !== null && explicit !== undefined) {
      return explicit;
    }
    return conversationHasAudio;
  }

  /**
   * Resolves `include_traces` for this evaluation.
   * Defaults to `true` when OTel / LangWatch is configured.
   *
   * Port of `python/scenario/judge_agent.py:effective_include_traces`.
   */
  effectiveIncludeTraces(otelConfigured: boolean): boolean {
    const explicit = this.cfg.includeTraces;
    if (explicit !== null && explicit !== undefined) {
      return explicit;
    }
    return otelConfigured;
  }

  /**
   * Run the automatic STT pre-pass over the judge's input messages (EDR §3.3).
   *
   * Returns the original messages unchanged when the conversation has no
   * audio (the text-only fast path — no provider constructed, no async cost).
   * When audio is present, resolves the per-run STT provider off
   * `input.scenarioConfig.voice` (falling back to the per-run OpenAI default),
   * computes `effectiveIncludeAudio` against the judge model's capability, and
   * delegates to {@link prepareJudgeInput} — which transcribes audio parts to
   * text (and keeps the audio for a multimodal model iff includeAudio).
   */
  private async transcribeAudioForJudge(
    input: AgentInput,
  ): Promise<ModelMessage[]> {
    const hasAudio = JudgeAgent.conversationHasAudio(input.messages);
    if (!hasAudio) {
      return input.messages;
    }
    // The carrier that reaches call() is cfg.voice (ADR-002). Resolve the
    // per-run provider; resolveVoiceConfig constructs the OpenAI default when
    // cfg.voice.stt is unset (a pure per-run default, not a global).
    const resolved = resolveVoiceConfig(undefined, input.scenarioConfig.voice);
    const includeAudio = this.effectiveIncludeAudio(hasAudio);
    const prepared = await prepareJudgeInput({
      messages: input.messages,
      stt: resolved.stt,
      options: { includeAudio },
      logWarn: (m) => this.logger.warn(m),
    });
    return prepared.messages;
  }

  async call(input: AgentInput): Promise<JudgeResult | null> {
    const criteria = input.judgmentRequest?.criteria ?? this.criteria;

    this.logger.debug("call() invoked", {
      threadId: input.threadId,
      currentTurn: input.scenarioState.currentTurn,
      maxTurns: input.scenarioConfig.maxTurns,
      judgmentRequest: input.judgmentRequest,
    });

    const cfg = this.cfg;

    const maxTurns = input.scenarioConfig.maxTurns ?? DEFAULT_MAX_TURNS;
    const isLastMessage = input.scenarioState.currentTurn >= maxTurns - 1;

    const enforceJudgement = input.judgmentRequest != null;
    const hasCriteria = criteria.length && criteria.length > 0;

    if (enforceJudgement && !hasCriteria) {
      return {
        success: false,
        reasoning: "JudgeAgent: No criteria was provided to be judged against",
        metCriteria: [],
        unmetCriteria: [],
      };
    }

    // A judgment is required when the conversation cannot continue past this
    // call: the last turn, or an explicit judge() step. Both go straight to
    // the verdict phase; only an unforced mid-conversation call runs the
    // decision phase first.
    const judgmentRequired = isLastMessage || enforceJudgement;

    // minTurns floor (ADR-005): below the floor the decision is predetermined
    // (the conversation must continue), so nothing is spent on it. The check
    // runs before the audio pre-pass, or a gated voice turn pays for a
    // transcription it discards. The judge observes a 0-based currentTurn:
    // the executor's constructor overrides the initial newTurn() back to 0,
    // so the call on turn N sees currentTurn N-1. The floor is unmet while
    // currentTurn < minTurns: with minTurns: 4, the first decision call
    // happens on the turn-5 call. A required judgment is never gated.
    const minTurns = input.scenarioConfig.minTurns;
    if (
      !judgmentRequired &&
      minTurns != null &&
      input.scenarioState.currentTurn < minTurns
    ) {
      return null;
    }

    const projectConfig = await getProjectConfig();

    // Remote trace fetching: the per-run scenario config wins over the
    // project-wide scenario.config.js defaults.
    const fetchRemoteTraces =
      input.scenarioConfig.fetchRemoteTraces ??
      projectConfig?.fetchRemoteTraces ??
      false;
    const traceWaitTimeoutMs = this.resolveWaitBudgetMs({
      field: "traceWaitTimeoutMs",
      values: [
        input.scenarioConfig.traceWaitTimeoutMs,
        projectConfig?.traceWaitTimeoutMs,
      ],
      fallback: DEFAULT_TRACE_WAIT_TIMEOUT_MS,
    });
    // The one extra wait the judge may request via the wait_for_traces tool.
    // Defaults to the wait budget itself; the platform passes its upper cap
    // here so a short measured budget still gets a meaningful extension.
    const traceWaitExtensionMs = this.resolveWaitBudgetMs({
      field: "traceWaitExtensionMs",
      values: [
        input.scenarioConfig.traceWaitExtensionMs,
        projectConfig?.traceWaitExtensionMs,
      ],
      fallback: traceWaitTimeoutMs,
    });
    const traceFetcher = cfg.traceFetcher ?? remoteTraceFetcher;

    // Automatic STT pre-pass (EDR §3.3 / §7.7): when the conversation carries
    // audio, transcribe audio `file` parts to text using the per-run resolved
    // STT provider BEFORE building the transcript — so the judge reads spoken
    // words, not a `[AUDIO: …]` byte-marker. The judge does NOT request a
    // transcript (no such tool, §7.3); STT is automatic and upstream. The
    // transcript is shared by both phases.
    const messagesForTranscript = await this.transcribeAudioForJudge(input);
    const transcript = JudgeUtils.buildTranscriptFromMessages(
      messagesForTranscript,
    );

    const mergedConfig = modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...cfg,
    });

    let verdictForced: boolean;
    let exhaustedEntry = false;
    let discoveryRecap: ModelMessage[] = [];
    if (judgmentRequired) {
      verdictForced = true;
    } else {
      const outcome = await this.runDecisionPhase({
        input,
        criteria,
        transcript,
        fetchRemoteTraces,
        mergedConfig,
      });
      if (outcome.decision === "continue") return null;
      if (outcome.decision === "failed") return outcome.result;
      // "verdict": the judge chose to end the conversation. Its verdict stays
      // voluntary so an inconclusive outcome continues the conversation
      // (#886). "exhausted": the decision loop burned its discovery steps
      // without deciding; the verdict is forced so the run cannot churn
      // through discovery again every turn.
      verdictForced = outcome.decision === "exhausted";
      exhaustedEntry = outcome.decision === "exhausted";
      discoveryRecap =
        outcome.decision === "exhausted" ? outcome.discoveryRecap : [];
    }

    return this.runJudgmentPhase({
      input,
      criteria,
      transcript,
      fetchRemoteTraces,
      traceWaitTimeoutMs,
      traceWaitExtensionMs,
      traceFetcher,
      mergedConfig,
      verdictForced,
      exhaustedEntry,
      discoveryRecap,
    });
  }

  /**
   * Picks the first usable wait budget in milliseconds, in precedence order.
   *
   * `ScenarioConfig` is a plain TypeScript interface, so a caller can pass
   * `Infinity` or `NaN` and nothing rejects it before it reaches the fetcher,
   * where it becomes a non-finite deadline that polls forever. A value that
   * is not a finite positive number is dropped with a warning and the next
   * source is used, ending at `fallback`.
   */
  private resolveWaitBudgetMs({
    field,
    values,
    fallback,
  }: {
    field: string;
    values: (number | undefined)[];
    fallback: number;
  }): number {
    for (const value of values) {
      if (value == null) continue;
      if (Number.isFinite(value) && value > 0) return value;
      this.logger.warn(
        `${field} must be a finite positive number of milliseconds; ignoring it`,
        { value: String(value) }
      );
    }
    return fallback;
  }

  /**
   * Phase 1 of the two-phase judge: continue, or move to the verdict.
   *
   * The outcome is "continue", "verdict", "exhausted" (the discovery loop
   * ran out of steps without a decision; any discovery cycles found in the
   * message history ride along collapsed to plain text so the forced verdict
   * keeps what was gathered), or "failed" carrying a fail-closed JudgeResult
   * for a malformed completion. Never fetches remote traces and never
   * produces a verdict; the span digest here holds only what the local
   * collector already has.
   */
  private async runDecisionPhase({
    input,
    criteria,
    transcript,
    fetchRemoteTraces,
    mergedConfig,
  }: {
    input: AgentInput;
    criteria: string[];
    transcript: string;
    fetchRemoteTraces: boolean;
    mergedConfig: ReturnType<typeof modelSchema.parse>;
  }): Promise<
    | { decision: "continue" | "verdict" }
    | { decision: "exhausted"; discoveryRecap: ModelMessage[] }
    | { decision: "failed"; result: JudgeResult }
  > {
    const spans = this.spanCollector.getSpansForThread(input.threadId);
    const { digest, isLargeTrace } = this.buildTraceDigest(spans);

    const contentForJudge = buildJudgeContent({
      transcript,
      digest,
      additionalContextSection: "",
    });

    const systemPrompt = this.cfg.systemPrompt
      ? this.cfg.systemPrompt +
        `\n\n${DECISION_PHASE_RULE}` +
        (fetchRemoteTraces ? `\n\n${REMOTE_TRACE_DECISION_RULE}` : "")
      : buildDecisionSystemPrompt({
          criteria,
          description: input.scenarioConfig.description,
          fetchRemoteTraces,
        });

    const tools: ToolSet = {
      ...(isLargeTrace ? buildProgressiveDiscoveryTools(spans) : {}),
      continue_test: buildContinueTestTool(),
      make_verdict: buildMakeVerdictTool(),
    };

    const params: InvokeLLMParams = {
      model: mergedConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentForJudge },
      ],
      temperature: mergedConfig.temperature,
      maxOutputTokens: mergedConfig.maxTokens,
      tools,
      toolChoice: "required",
    };
    if (isLargeTrace) {
      params.stopWhen = [
        stepCountIs(this.maxDiscoverySteps),
        hasToolCall("continue_test"),
        hasToolCall("make_verdict"),
      ];
    }

    this.logger.debug("Calling LLM for the decision", {
      model: mergedConfig.model,
      isLargeTrace,
    });

    const completion = await this.invokeLLM(params);

    if (this.completionCalledTool(completion, "continue_test")) {
      this.logger.debug("decision: continue_test - proceeding to next turn");
      return { decision: "continue" };
    }
    if (this.completionCalledTool(completion, "make_verdict")) {
      this.logger.debug("decision: make_verdict - moving to the verdict");
      return { decision: "verdict" };
    }
    if (isLargeTrace) {
      this.logger.debug(
        "decision discovery exhausted its steps without a decision - forcing the verdict"
      );
      // generateText never writes back into params.messages, so the discovery
      // cycles live only on the completion steps. Recombine both before
      // collapsing, then drop the two messages the verdict phase rebuilds by
      // itself (the system prompt and the criteria block).
      const discoveryHistory: ModelMessage[] = [
        ...(params.messages ?? []),
        ...(completion.steps ?? []).flatMap((step) => [
          ...step.response.messages,
        ]),
      ];
      return {
        decision: "exhausted",
        discoveryRecap: collapseDiscoveryHistory(discoveryHistory).slice(2),
      };
    }
    return {
      decision: "failed",
      result: {
        success: false,
        reasoning: "JudgeAgent: No decision tool call found in LLM output",
        metCriteria: [],
        unmetCriteria: criteria,
      },
    };
  }

  /**
   * Phase 2 of the two-phase judge: the verdict itself.
   *
   * Settle-waits for the remote traces first when fetching is on (the only
   * fetch site), so the digest always holds the full evidence, then makes a
   * finish_test-pinned evaluation. When the traces are still incomplete
   * after the settle-wait, the call also offers a one-shot `wait_for_traces`
   * tool: calling it settle-waits once more under the extension budget and
   * re-enters the verdict with the tool withdrawn, so the second call must
   * decide. `verdictForced` reflects the entry mode:
   * a required judgment (last turn, explicit judge() step) or
   * decision-discovery exhaustion makes an inconclusive verdict terminal; a
   * voluntary make_verdict entry lets an inconclusive verdict continue the
   * conversation (#886), unless not one remote trace of the run ever
   * settled, in which case more turns cannot improve the evidence and the
   * verdict stands. An `exhaustedEntry` skips further discovery: the
   * decision loop already spent the budget, so the verdict is one pinned
   * call.
   */
  private async runJudgmentPhase({
    input,
    criteria,
    transcript,
    fetchRemoteTraces,
    traceWaitTimeoutMs,
    traceWaitExtensionMs,
    traceFetcher,
    mergedConfig,
    verdictForced,
    exhaustedEntry,
    discoveryRecap,
  }: {
    input: AgentInput;
    criteria: string[];
    transcript: string;
    fetchRemoteTraces: boolean;
    traceWaitTimeoutMs: number;
    traceWaitExtensionMs: number;
    traceFetcher: RemoteTraceFetcher;
    mergedConfig: ReturnType<typeof modelSchema.parse>;
    verdictForced: boolean;
    exhaustedEntry: boolean;
    discoveryRecap: ModelMessage[];
  }): Promise<JudgeResult | null> {
    const remoteTraceIds = fetchRemoteTraces
      ? collectMessageTraceIds(input.messages)
      : [];
    const settleTarget = {
      threadId: input.threadId,
      traceIds: remoteTraceIds,
      collector: this.spanCollector,
      langwatch: input.scenarioConfig.langwatch,
    };
    let allSettled = true;
    if (fetchRemoteTraces && remoteTraceIds.length > 0) {
      ({ allSettled } = await traceFetcher.settleWait({
        ...settleTarget,
        timeoutMs: traceWaitTimeoutMs,
      }));
    } else if (fetchRemoteTraces) {
      // Fetching is on and there is nothing to fetch. Without this the traces
      // section is silently empty and the judge marks internal criteria
      // inconclusive without a stated reason.
      this.logger.warn(
        "Remote trace fetching is on but no message carries a trace id; nothing to fetch"
      );
      traceFetcher.recordMissingTraceIds({
        threadId: input.threadId,
        collector: this.spanCollector,
      });
    }

    // The judge's one extra wait: offered as a wait_for_traces tool while the
    // traces are incomplete, consumed at most once, then withdrawn so the
    // second call must decide. With no trace ids at all there is nothing a
    // wait could produce, so the tool is never offered.
    let waitExtensionAvailable =
      fetchRemoteTraces &&
      remoteTraceIds.length > 0 &&
      !allSettled &&
      traceWaitExtensionMs > 0;
    let waitedOnce = false;

    while (true) {
      // When not one remote trace of the run ever settled, more turns cannot
      // produce trace evidence: a voluntary inconclusive verdict would loop
      // (verdict, continue, settle, inconclusive again) all the way to the
      // turn cap, paying the settle budget every turn. The verdict becomes
      // terminal instead; with any settled trace, #886 semantics stay.
      // Recomputed after an extension wait, which can settle the traces.
      const evidenceExhausted =
        fetchRemoteTraces &&
        remoteTraceIds.length > 0 &&
        traceFetcher.noneSettled(input.threadId, remoteTraceIds);
      const verdictIsTerminal = verdictForced || evidenceExhausted;

      const spans = this.spanCollector.getSpansForThread(input.threadId);
      const { digest, isLargeTrace } = this.buildTraceDigest(spans);

      const extraContext =
        input.judgmentRequest?.additionalContext ??
        input.judgmentRequest?.context;
      const additionalContextSection = extraContext
        ? `\n    <additional_context>\n    ${extraContext}\n    </additional_context>`
        : "";

      const contentForJudge = buildJudgeContent({
        transcript,
        digest,
        additionalContextSection,
      });

      const systemPrompt = this.cfg.systemPrompt
        ? this.cfg.systemPrompt +
          (fetchRemoteTraces ? `\n\n${REMOTE_TRACE_JUDGING_RULE}` : "")
        : buildVerdictSystemPrompt({
            criteria,
            description: input.scenarioConfig.description,
            fetchRemoteTraces,
          });

      const messages: ModelMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentForJudge },
      ];

      if (exhaustedEntry) {
        // The decision loop already spent the discovery budget; its collapsed
        // cycles are replayed as context and the verdict is one pinned call.
        messages.push(...discoveryRecap);
        messages.push({
          role: "user",
          content:
            "You have reached the maximum number of trace exploration steps. " +
            "Based on the information you have gathered so far, give your final verdict now.",
        });
      }

      if (waitedOnce) {
        messages.push({
          role: "user",
          content:
            "You already waited once more for the remote traces. The trace evidence above is final: deliver your verdict now.",
        });
      }

      // finish_test is the only terminal tool of the verdict phase and the
      // tool choice pins it: continuing is the decision phase's business.
      // While the traces are incomplete and the extension is unused, the
      // wait_for_traces tool joins the set and the pin relaxes to "required"
      // so the judge can pick either. The large-trace path also relaxes the
      // pin so the judge can use discovery tools, and forces the verdict on
      // exhaustion.
      const tools: ToolSet = {
        ...(isLargeTrace && !exhaustedEntry
          ? buildProgressiveDiscoveryTools(spans)
          : {}),
        ...(waitExtensionAvailable
          ? { wait_for_traces: buildWaitForTracesTool() }
          : {}),
        finish_test: buildFinishTestTool(criteria),
      };

      const params: InvokeLLMParams = {
        model: mergedConfig.model,
        messages,
        temperature: mergedConfig.temperature,
        maxOutputTokens: mergedConfig.maxTokens,
        tools,
        toolChoice: waitExtensionAvailable
          ? "required"
          : { type: "tool", toolName: "finish_test" },
      };
      if (isLargeTrace && !exhaustedEntry) {
        params.toolChoice = "required";
        params.stopWhen = [
          stepCountIs(this.maxDiscoverySteps),
          hasToolCall("finish_test"),
          ...(waitExtensionAvailable ? [hasToolCall("wait_for_traces")] : []),
        ];
      }

      this.logger.debug("Calling LLM for the verdict", {
        model: mergedConfig.model,
        isLargeTrace,
        verdictForced,
        evidenceExhausted,
        exhaustedEntry,
        waitExtensionAvailable,
        waitedOnce,
      });

      let completion = await this.invokeLLM(params);

      if (
        waitExtensionAvailable &&
        this.completionCalledTool(completion, "wait_for_traces")
      ) {
        this.logger.debug(
          "Judge requested one more wait for the remote traces",
          { extensionMs: traceWaitExtensionMs }
        );
        waitExtensionAvailable = false;
        waitedOnce = true;
        await traceFetcher.extendSettle({
          ...settleTarget,
          timeoutMs: traceWaitExtensionMs,
        });
        continue;
      }

      let verdictWasForced = false;
      if (
        isLargeTrace &&
        !exhaustedEntry &&
        !this.completionCalledTool(completion, "finish_test")
      ) {
        // Discovery ran out of steps without the verdict: pin finish_test.
        completion = await this.forceVerdict(params);
        verdictWasForced = true;
      }

      return this.parseToolCalls(completion, criteria, {
        verdictForced: verdictIsTerminal || verdictWasForced,
      });
    }
  }

  /**
   * Builds the trace digest, choosing between full inline rendering
   * and structure-only mode based on estimated token count.
   */
  private buildTraceDigest(spans: ReadableSpan[]): {
    digest: string;
    isLargeTrace: boolean;
  } {
    const fullDigest = judgeSpanDigestFormatter.format(spans);
    const isLargeTrace =
      spans.length > 0 && estimateTokens(fullDigest) > this.tokenThreshold;

    const digest = isLargeTrace
      ? judgeSpanDigestFormatter.formatStructureOnly(spans) +
        "\n\nUse expand_trace(span_id) to see span details or grep_trace(pattern) to search across spans. Reference spans by the ID shown in brackets."
      : fullDigest;

    this.logger.debug("Trace digest built", {
      isLargeTrace,
      estimatedTokens: estimateTokens(fullDigest),
    });

    return { digest, isLargeTrace };
  }

  /**
   * True when `toolName` was called anywhere in the (possibly multi-step)
   * completion — the aggregate `steps` array when present, else the final
   * `toolCalls`. AI SDK v6 surfaces only the final step in
   * `completion.toolCalls`; a terminal call earlier in the loop would be
   * invisible there.
   */
  private completionCalledTool(
    completion: InvokeLLMResult,
    toolName: string
  ): boolean {
    const steps = completion.steps;
    if (steps && steps.length > 0) {
      return steps.some((step) =>
        step.toolCalls?.some((tc) => tc.toolName === toolName)
      );
    }
    return Boolean(completion.toolCalls?.some((tc) => tc.toolName === toolName));
  }

  /**
   * Makes one final LLM call with `tool_choice` forced to `finish_test`.
   *
   * Hardening (vs. a naive re-invocation with the same tool set):
   *  - Prior discovery tool_use/tool_result pairs are rewritten in the
   *    message history as plain-text assistant recaps. This lets us drop
   *    `expand_trace`/`grep_trace` from the tool set without Anthropic
   *    rejecting the call for referencing undefined tools.
   *  - Discovery tools are then stripped so the model physically cannot
   *    emit them, closing the leak path where `tool_choice` wasn't
   *    honored and a discovery tool reached `parseToolCalls`.
   */
  private async forceVerdict(
    params: InvokeLLMParams
  ): Promise<InvokeLLMResult> {
    this.logger.warn(
      `Discovery exhausted max steps (${this.maxDiscoverySteps}), forcing verdict`
    );
    const {
      stopWhen: _sw,
      prompt: _p,
      messages: prevMessages,
      toolChoice: _tc,
      tools: prevTools,
      ...rest
    } = params;

    const rewrittenMessages = collapseDiscoveryHistory(prevMessages ?? []);
    // finish_test only, not just "everything except discovery". The verdict
    // phase also offers wait_for_traces while the extension is unused, and it
    // would survive a deny-list. The pin below asks for finish_test, but a
    // model that ignores the pin and calls wait_for_traces here reaches
    // parseToolCalls as an invalid tool call. Leaving one tool closes that
    // path.
    const finishOnlyTools: ToolSet | undefined = prevTools
      ? (Object.fromEntries(
          Object.entries(prevTools).filter(([name]) => name === "finish_test")
        ) as ToolSet)
      : undefined;

    return this.invokeLLM({
      ...rest,
      tools: finishOnlyTools,
      messages: [
        ...rewrittenMessages,
        {
          role: "user" as const,
          content:
            "You have reached the maximum number of trace exploration steps. " +
            "Based on the information you have gathered so far, give your final verdict now.",
        },
      ],
      toolChoice: { type: "tool" as const, toolName: "finish_test" },
    });
  }

  private parseToolCalls(
    completion: InvokeLLMResult,
    criteria: string[],
    { verdictForced }: { verdictForced: boolean }
  ): JudgeResult | null {
    let args: FinishTestArgs | undefined;
    if (completion.toolCalls?.length) {
      // In multi-step mode, find the terminal tool call
      const terminalCall = completion.toolCalls.find(
        (tc) => tc.toolName === "finish_test"
      );
      const toolCall = terminalCall ?? completion.toolCalls[0];

      switch (toolCall.toolName) {
        case "finish_test": {
          args = toolCall.input as FinishTestArgs;

          const verdict = args.verdict || "inconclusive";

          // "Can't tell yet" is not a verdict (#886). When nothing forced the
          // judge to finish — continue_test was freely available — an
          // inconclusive finish_test used to end the run as FAILED, which in
          // the UI reads as the user simulator going silent mid-conversation.
          // Treat it as continue_test and let the conversation play out; a
          // FORCED judgment (last turn, judge() checkpoint, discovery
          // exhaustion) keeps its terminal behavior unchanged.
          if (!verdictForced && verdict === "inconclusive") {
            this.logger.debug(
              "finish_test returned an inconclusive verdict without a forced judgment - continuing the conversation"
            );
            return null;
          }
          const reasoning = args.reasoning || "No reasoning provided";
          const criteriaArgs = args.criteria || {};
          const criteriaValues = Object.values(criteriaArgs);
          const metCriteria = criteria.filter(
            (_, i) => criteriaValues[i] === "true"
          );
          const unmetCriteria = criteria.filter(
            (_, i) => criteriaValues[i] !== "true"
          );

          const result = {
            success: verdict === "success",
            reasoning,
            metCriteria,
            unmetCriteria,
          };
          this.logger.debug("finish_test result", result);
          return result;
        }

        default:
          if (
            toolCall.toolName === "expand_trace" ||
            toolCall.toolName === "grep_trace"
          ) {
            this.logger.warn(
              `Discovery tool ${toolCall.toolName} leaked past discovery loop without reaching a terminal verdict`
            );
            return {
              success: false,
              reasoning:
                "JudgeAgent: trace discovery did not converge on a verdict within the step budget",
              metCriteria: [],
              unmetCriteria: criteria,
              // Infrastructure failure, not a verdict — downstream consumers
              // (the red-team report) file this as errored, not a break (#888).
              error:
                "JudgeAgent: trace discovery did not converge on a verdict within the step budget",
            };
          }
          return {
            success: false,
            reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
            metCriteria: [],
            unmetCriteria: criteria,
            // Infrastructure failure, not a verdict (#888).
            error: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
          };
      }
    }

    return {
      success: false,
      reasoning: `JudgeAgent: No tool call found in LLM output`,
      metCriteria: [],
      unmetCriteria: criteria,
      // Infrastructure failure, not a verdict (#888).
      error: `JudgeAgent: No tool call found in LLM output`,
    };
  }
}

/**
 * Factory function for creating JudgeAgent instances.
 *
 * JudgeAgent evaluates conversations against success criteria.
 *
 * The JudgeAgent watches conversations in real-time and makes decisions about
 * whether the agent under test is meeting the specified criteria. It can either
 * allow the conversation to continue or end it with a success/failure verdict.
 *
 * The judge uses function calling to make structured decisions and provides
 * detailed reasoning for its verdicts. It evaluates each criterion independently
 * and provides comprehensive feedback about what worked and what didn't.
 *
 * @param cfg Configuration for the judge agent.
 * @param cfg.criteria List of success criteria to evaluate against.
 * @param cfg.model Optional The language model to use for generating responses.
 * @param cfg.temperature Optional The temperature to use for the model.
 * @param cfg.maxTokens Optional The maximum number of tokens to generate.
 * @param cfg.systemPrompt Optional Custom system prompt to override default judge behavior.
 *
 * @example
 * ```typescript
 * import { run, judgeAgent, AgentRole, user, agent, AgentAdapter } from '@langwatch/scenario';
 *
 * const myAgent: AgentAdapter = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `The user said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 *
 * async function main() {
 *   const result = await run({
 *     name: "Judge Agent Test",
 *     description: "A simple test to see if the judge agent works.",
 *     agents: [
 *       myAgent,
 *       judgeAgent({
 *         criteria: ["The agent must respond to the user."],
 *       }),
 *     ],
 *     script: [
 *       user("Hello!"),
 *       agent(),
 *     ],
 *   });
 * }
 * main();
 * ```
 */
export const judgeAgent = (cfg?: JudgeAgentConfig) => {
  return new JudgeAgent(cfg ?? {});
};
