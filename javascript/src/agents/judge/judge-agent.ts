import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  ModelMessage,
  ToolSet,
  Tool,
  ToolChoice,
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
import { AgentInput, JudgeAgentAdapter, AgentRole, DEFAULT_MAX_TURNS } from "../../domain";
import { modelSchema } from "../../domain/core/schemas/model.schema";
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

function buildSystemPrompt(criteria: string[], description: string): string {
  const criteriaList =
    criteria?.map((criterion, idx) => `${idx + 1}. ${criterion}`).join("\n") ||
    "No criteria provided";

  return `
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to determine if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to determine if you already have enough information to make a verdict of the scenario below, or if the conversation should continue for longer.
If you do have enough information, use the finish_test tool to determine if all the criteria have been met, if not, use the continue_test tool to let the next step play out.
</goal>

<scenario>
${description}
</scenario>

<criteria>
${criteriaList}
</criteria>

<rules>
- Be strict, do not let the conversation continue if the agent already broke one of the "do not" or "should not" criteria.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
</rules>
`.trim();
}

function buildContinueTestTool(): Tool {
  return tool({
    description: "Continue the test with the next step",
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

    const spans = this.spanCollector.getSpansForThread(input.threadId);
    const { digest, isLargeTrace } = this.buildTraceDigest(spans);

    // Automatic STT pre-pass (EDR §3.3 / §7.7): when the conversation carries
    // audio, transcribe audio `file` parts to text using the per-run resolved
    // STT provider BEFORE building the transcript — so the judge reads spoken
    // words, not a `[AUDIO: …]` byte-marker. The judge does NOT request a
    // transcript (no such tool, §7.3); STT is automatic and upstream.
    const messagesForTranscript = await this.transcribeAudioForJudge(input);
    const transcript = JudgeUtils.buildTranscriptFromMessages(
      messagesForTranscript,
    );

    const extraContext = input.judgmentRequest?.additionalContext ?? input.judgmentRequest?.context;
    const additionalContextSection = extraContext
      ? `\n    <additional_context>\n    ${extraContext}\n    </additional_context>`
      : "";

    const contentForJudge = `
    <transcript>
    ${transcript}
    </transcript>
    <opentelemetry_traces>
    ${digest}
    </opentelemetry_traces>${additionalContextSection}
    `;

    const cfg = this.cfg;

    const systemPrompt =
      cfg.systemPrompt ??
      buildSystemPrompt(criteria, input.scenarioConfig.description);
    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: contentForJudge },
    ];

    const maxTurns = input.scenarioConfig.maxTurns ?? DEFAULT_MAX_TURNS;
    const isLastMessage = input.scenarioState.currentTurn >= maxTurns - 1;

    const projectConfig = await getProjectConfig();
    const mergedConfig = modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...cfg,
    });

    const tools: ToolSet = {
      ...(isLargeTrace ? buildProgressiveDiscoveryTools(spans) : {}),
      continue_test: buildContinueTestTool(),
      finish_test: buildFinishTestTool(criteria),
    };

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

    const toolChoice: ToolChoice<typeof tools> =
      (isLastMessage || enforceJudgement) && hasCriteria
        ? { type: "tool", toolName: "finish_test" }
        : "required";

    this.logger.debug("Calling LLM", {
      model: mergedConfig.model,
      toolChoice,
      isLastMessage,
      enforceJudgement,
      isLargeTrace,
    });

    const completion = await this.invokeLLMWithDiscovery({
      model: mergedConfig.model,
      messages,
      temperature: mergedConfig.temperature,
      maxOutputTokens: mergedConfig.maxTokens,
      tools,
      toolChoice,
      isLargeTrace,
    });

    return this.parseToolCalls(completion, criteria);
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
   * Invokes the LLM, enabling multi-step tool execution for large traces.
   * In multi-step mode, the AI SDK loops automatically: the judge can call
   * expand_trace/grep_trace tools multiple times before reaching a terminal
   * tool (finish_test/continue_test) or hitting the step limit.
   *
   * When the trace is large, toolChoice is relaxed to "required" so the
   * judge can freely pick discovery tools (expand_trace/grep_trace) before
   * being forced to a terminal decision.
   */
  private async invokeLLMWithDiscovery({
    isLargeTrace,
    ...params
  }: InvokeLLMParams & { isLargeTrace: boolean }): Promise<InvokeLLMResult> {
    if (isLargeTrace) {
      params.toolChoice = "required";
      params.stopWhen = [
        stepCountIs(this.maxDiscoverySteps),
        hasToolCall("finish_test"),
        hasToolCall("continue_test"),
      ];
    }

    const completion = await this.invokeLLM(params);

    this.logger.debug("LLM response received", {
      toolCallCount: completion.toolCalls?.length ?? 0,
      toolCalls: completion.toolCalls?.map((tc) => ({
        toolName: tc.toolName,
        args: tc.input,
      })),
    });

    if (isLargeTrace && this.discoveryExhausted(completion)) {
      return this.forceVerdict(params);
    }

    return completion;
  }

  /**
   * Checks whether the discovery loop ran out of steps without the judge
   * calling finish_test or continue_test.
   *
   * AI SDK v6 surfaces only the final step in `completion.toolCalls`; if a
   * terminal call happened earlier in the loop, it would be invisible here.
   * Inspect the aggregate `steps` array when present so we don't force a
   * verdict on a run that already resolved.
   *
   * `continue_test` counts as non-exhausted: the judge explicitly asked to
   * keep going, so the loop is progressing — forcing a verdict would be wrong.
   */
  private discoveryExhausted(completion: InvokeLLMResult): boolean {
    const steps = completion.steps;
    if (steps && steps.length > 0) {
      const anyTerminal = steps.some((step) =>
        step.toolCalls?.some(
          (tc) =>
            tc.toolName === "finish_test" || tc.toolName === "continue_test"
        )
      );
      return !anyTerminal;
    }

    if (!completion.toolCalls?.length) return false;
    return !completion.toolCalls.some(
      (tc) =>
        tc.toolName === "finish_test" || tc.toolName === "continue_test"
    );
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
    const finishOnlyTools: ToolSet | undefined = prevTools
      ? (Object.fromEntries(
          Object.entries(prevTools).filter(
            ([name]) => !DISCOVERY_TOOL_NAMES.has(name)
          )
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
    criteria: string[]
  ): JudgeResult | null {
    let args: FinishTestArgs | undefined;
    if (completion.toolCalls?.length) {
      // In multi-step mode, find the terminal tool call (finish_test or continue_test)
      const terminalCall = completion.toolCalls.find(
        (tc) =>
          tc.toolName === "finish_test" || tc.toolName === "continue_test"
      );
      const toolCall = terminalCall ?? completion.toolCalls[0];

      switch (toolCall.toolName) {
        case "finish_test": {
          args = toolCall.input as FinishTestArgs;

          const verdict = args.verdict || "inconclusive";
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

        case "continue_test":
          this.logger.debug("continue_test - proceeding to next turn");
          return null;

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
            };
          }
          return {
            success: false,
            reasoning: `JudgeAgent: Unknown tool call: ${toolCall.toolName}`,
            metCriteria: [],
            unmetCriteria: criteria,
          };
      }
    }

    return {
      success: false,
      reasoning: `JudgeAgent: No tool call found in LLM output`,
      metCriteria: [],
      unmetCriteria: criteria,
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
