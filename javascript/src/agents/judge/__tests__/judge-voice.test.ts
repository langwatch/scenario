/**
 * Judge voice-path tests — PR4 of issue #372.
 *
 * Binds 7 scenarios from `specs/voice-agents.feature` tagged `@ts-judge`.
 * Each scenario exercises the voice-aware behaviors of {@link JudgeAgent}:
 * auto-detect, always-transcript, multimodal pass-through, transcript-only
 * fallback, structured timeline, OTel traces, and `includeAudio=false` hatch.
 *
 * All behaviors are tested at the unit level against the judge's helper
 * methods — no LLM call is made. The scenarios cover configuration-resolution
 * logic (effectiveIncludeAudio, effectiveIncludeTimeline, effectiveIncludeTraces)
 * and the static `conversationHasAudio` detector.
 *
 * Tag convention: `@ts-judge` (per-subject) — see issue #523.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { describe, expect, it } from "vitest";

import { createAudioMessage } from "../../../voice/messages";
import { makeChunk } from "../../__tests__/fixtures/make-chunk";
import { judgeAgent, JudgeAgent, type JudgeAgentConfig } from "../judge-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** Build a message-bus message containing audio content. */
function audioMessage(
  role: "user" | "assistant" = "user",
  transcript?: string
): unknown {
  return createAudioMessage(makeChunk(transcript), role);
}

/** Build a plain text message-bus message. */
function textMessage(role: "user" | "assistant", content: string): unknown {
  return { role, content };
}

// ---------------------------------------------------------------------------
// Implementation-level model-substring coverage (not named spec scenarios)
// Lifted out of bound Then blocks to keep Thens honest per /review FIX #4.
// ---------------------------------------------------------------------------

describe("modelSupportsAudio — model substring detection", () => {
  it("gpt-4o is recognised as multimodal", () => {
    expect(judgeAgent({ model: "openai/gpt-4o", criteria: [] }).modelSupportsAudio()).toBe(true);
  });

  it("gemini-2.5-pro is recognised as multimodal", () => {
    expect(judgeAgent({ model: "gemini-2.5-pro", criteria: [] }).modelSupportsAudio()).toBe(true);
  });

  it("gemini-2.0-flash is recognised as multimodal", () => {
    expect(judgeAgent({ model: "gemini-2.0-flash", criteria: [] }).modelSupportsAudio()).toBe(true);
  });

  it("openai/gpt-4 is NOT multimodal", () => {
    expect(judgeAgent({ model: "openai/gpt-4", criteria: [] }).modelSupportsAudio()).toBe(false);
  });

  it("openai/gpt-3.5-turbo is NOT multimodal", () => {
    expect(judgeAgent({ model: "openai/gpt-3.5-turbo", criteria: [] }).modelSupportsAudio()).toBe(false);
  });

  it("openai/gpt-4.1-mini is NOT multimodal", () => {
    expect(judgeAgent({ model: "openai/gpt-4.1-mini", criteria: [] }).modelSupportsAudio()).toBe(false);
  });
});

describe("effectiveIncludeTimeline — explicit overrides", () => {
  it("explicit false wins over voice conversation", () => {
    const judge = judgeAgent({
      model: "openai/gpt-4o",
      includeTimeline: false,
      criteria: [],
    });
    expect(judge.effectiveIncludeTimeline(true)).toBe(false);
  });

  it("explicit true wins over text-only conversation", () => {
    const judge = judgeAgent({
      model: "openai/gpt-4.1-mini",
      includeTimeline: true,
      criteria: [],
    });
    expect(judge.effectiveIncludeTimeline(false)).toBe(true);
  });

  it("text-only conversation defaults to false", () => {
    const judge = judgeAgent({ model: "openai/gpt-4o", criteria: [] });
    expect(judge.effectiveIncludeTimeline(false)).toBe(false);
  });
});

describe("effectiveIncludeTraces — explicit overrides", () => {
  it("explicit true overrides when otelConfigured=false", () => {
    const judge = judgeAgent({
      model: "openai/gpt-4.1-mini",
      includeTraces: true,
      criteria: [],
    });
    expect(judge.effectiveIncludeTraces(false)).toBe(true);
  });

  it("explicit false overrides when otelConfigured=true", () => {
    const judge = judgeAgent({
      model: "openai/gpt-4.1-mini",
      includeTraces: false,
      criteria: [],
    });
    expect(judge.effectiveIncludeTraces(true)).toBe(false);
  });

  it("no OTel defaults to false", () => {
    const judge = judgeAgent({ model: "openai/gpt-4.1-mini", criteria: [] });
    expect(judge.effectiveIncludeTraces(false)).toBe(false);
  });
});

describe("effectiveIncludeAudio — explicit override edge cases", () => {
  it("explicit true on a non-multimodal model still requires audio in conversation", () => {
    const judge = judgeAgent({
      model: "openai/gpt-4.1-mini",
      includeAudio: true,
      criteria: [],
    });
    // conversationHasAudio=true AND explicit=true → true.
    expect(judge.effectiveIncludeAudio(true)).toBe(true);
    // conversationHasAudio=false AND explicit=true → false (no audio to include).
    expect(judge.effectiveIncludeAudio(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bound feature-file scenarios
// ---------------------------------------------------------------------------

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: Judge auto-detects audio messages without configuration (line 215)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge auto-detects audio messages without configuration",
      ({ Given, And, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let messages: unknown[];
        let conversationHasAudio: boolean;
        let effectiveAudio: boolean;

        Given("JudgeAgent(criteria=[...]) with no audio flags set", () => {
          // No includeAudio set → null / undefined (auto-detect mode).
          const cfg: JudgeAgentConfig = {
            criteria: ["Agent is helpful"],
            model: "openai/gpt-4o",
          };
          judge = judgeAgent(cfg);
          conversationHasAudio = false;
          effectiveAudio = false;
        });

        And("the conversation contains audio messages", () => {
          messages = [
            audioMessage("user", "hello"),
            textMessage("assistant", "How can I help?"),
          ];
          // Detect audio using the static helper.
          conversationHasAudio = JudgeAgent.conversationHasAudio(messages);
        });

        When("the judge evaluates", () => {
          // Resolve the effective include_audio (no explicit override → auto-detect).
          effectiveAudio = judge.effectiveIncludeAudio(conversationHasAudio);
        });

        Then("it auto-enables audio handling", () => {
          // Audio was detected in the conversation.
          expect(conversationHasAudio).toBe(true);
          // gpt-4o is multimodal → auto-detect enables audio.
          expect(effectiveAudio).toBe(true);

          // Sanity: text-only conversation → conversationHasAudio=false.
          const textOnly = [textMessage("user", "hi"), textMessage("assistant", "hello")];
          expect(JudgeAgent.conversationHasAudio(textOnly)).toBe(false);
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Judge always includes transcripts of audio messages (line 223)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge always includes transcripts of audio messages",
      ({ Given, When, Then }) => {
        let messages: unknown[];
        let audioDetected: boolean;

        Given("the conversation has audio turns", () => {
          // Audio message carries a transcript in the text content part (from
          // createAudioMessage when chunk.transcript is set).
          messages = [
            audioMessage("user", "I need help please"),
            textMessage("assistant", "Sure!"),
          ];
          audioDetected = false;
        });

        When("the judge evaluates", () => {
          audioDetected = JudgeAgent.conversationHasAudio(messages);
        });

        Then("every audio turn has an STT transcript attached to the input", () => {
          // Audio was detected.
          expect(audioDetected).toBe(true);

          // The audio message's content array includes a text part with the
          // transcript (prepended by createAudioMessage when transcript is set).
          const audioPart = messages[0] as {
            content: Array<{ type: string; text?: string }>;
          };
          const textPart = audioPart.content.find((p) => p.type === "text");
          expect(textPart).toBeDefined();
          expect(textPart!.text).toBe("I need help please");

          // An audio-only message (no transcript given) has no text part.
          const noTranscript = audioMessage("user"); // no transcript arg
          const noTranscriptMsg = noTranscript as {
            content: Array<{ type: string; text?: string }>;
          };
          const noText = noTranscriptMsg.content.find((p) => p.type === "text");
          expect(noText).toBeUndefined();
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Judge passes audio to multimodal models that support it (line 230)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge passes audio to multimodal models that support it",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let includeAudio: boolean;

        Given(
          'JudgeAgent(model="openai/gpt-4o") with audio in the conversation',
          () => {
            judge = judgeAgent({ model: "openai/gpt-4o", criteria: [] });
            includeAudio = false;
          }
        );

        When("the judge evaluates", () => {
          // conversationHasAudio=true; gpt-4o is multimodal → true.
          includeAudio = judge.effectiveIncludeAudio(true);
        });

        Then("the raw audio is passed to the model as multimodal input", () => {
          expect(includeAudio).toBe(true);
          expect(judge.modelSupportsAudio()).toBe(true);
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Judge falls back to transcript-only for non-multimodal models (line 237)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge falls back to transcript-only for non-multimodal models",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let includeAudio: boolean;

        Given(
          'JudgeAgent(model="openai/gpt-4.1-mini") with audio in the conversation',
          () => {
            judge = judgeAgent({ model: "openai/gpt-4.1-mini", criteria: [] });
            includeAudio = true; // will be resolved to false
          }
        );

        When("the judge evaluates", () => {
          // gpt-4.1-mini is NOT multimodal → auto-detect returns false.
          includeAudio = judge.effectiveIncludeAudio(true);
        });

        Then("audio is auto-transcribed and passed as text only", () => {
          expect(includeAudio).toBe(false);
          expect(judge.modelSupportsAudio()).toBe(false);
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Judge receives a structured timeline for voice conversations (line 244)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge receives a structured timeline for voice conversations",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let includeTimeline: boolean;

        Given(
          "a voice conversation with speaking/interrupt/tool-call events",
          () => {
            // No explicit includeTimeline → auto-detect.
            judge = judgeAgent({ model: "openai/gpt-4o", criteria: [] });
            includeTimeline = false;
          }
        );

        When("the judge evaluates", () => {
          // For a voice conversation (conversationHasAudio=true), timeline defaults true.
          includeTimeline = judge.effectiveIncludeTimeline(true);
        });

        Then(
          "include_timeline defaults to True and a structured timeline is present in AgentInput",
          () => {
            expect(includeTimeline).toBe(true);
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Judge receives OTel traces when configured (line 251)
    // -----------------------------------------------------------------------
    Scenario(
      "Judge receives OTel traces when configured",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let includeTraces: boolean;

        Given(
          "LangWatch/OTel is configured and the conversation contains spans",
          () => {
            judge = judgeAgent({ model: "openai/gpt-4.1-mini", criteria: [] });
            includeTraces = false;
          }
        );

        When("the judge evaluates", () => {
          // When OTel is configured (otelConfigured=true), traces default to true.
          includeTraces = judge.effectiveIncludeTraces(true);
        });

        Then("include_traces defaults to True and traces are included", () => {
          expect(includeTraces).toBe(true);
        });
      }
    );

    // -----------------------------------------------------------------------
    // Scenario: Explicit include_audio=False forces text-only judge for cost (line 258)
    // -----------------------------------------------------------------------
    Scenario(
      "Explicit include_audio=False forces text-only judge for cost",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let includeAudio: boolean;

        Given(
          "JudgeAgent(include_audio=False) with audio in the conversation",
          () => {
            const cfg: JudgeAgentConfig = {
              model: "openai/gpt-4o", // multimodal capable
              criteria: [],
              includeAudio: false, // explicit escape hatch
            };
            judge = judgeAgent(cfg);
            includeAudio = true; // will be resolved to false
          }
        );

        When("the judge evaluates", () => {
          includeAudio = judge.effectiveIncludeAudio(true /* conversation has audio */);
        });

        Then(
          "audio is not passed to the model even if the model supports it",
          () => {
            // Explicit false wins over the model's multimodal capability.
            expect(includeAudio).toBe(false);
            expect(judge.modelSupportsAudio()).toBe(true);
          }
        );
      }
    );
  },
  { includeTags: ["ts-judge"] }
);
