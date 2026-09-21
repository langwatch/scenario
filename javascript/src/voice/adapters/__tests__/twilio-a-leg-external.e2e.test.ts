/**
 * Live a-leg external-number smoke (scenario#762 Slice 5, AC11) — env-gated.
 *
 * Direct twin of `python/tests/voice/test_twilio_a_leg_external_e2e.py`. Dials a
 * real external number over a real Cloudflare quick tunnel and runs a scenario
 * over the Media Stream attached to OUR OWN leg (`attachStream: "a-leg"`). It
 * bills a PSTN call, so it never runs unless the operator has explicitly named
 * the destination in `SCENARIO_TWILIO_EXTERNAL_TO`; absent that (and the Twilio
 * creds), the whole block skips — CI (`pnpm run test:ci`) reports it skipped,
 * never failed.
 *
 * The ungated standing proof of the same frame loop is `twilio-frame-loop.test.ts`
 * (AC14) — this test is what an operator runs once against a real deployed agent,
 * not something CI can carry.
 *
 * How to run (operator, from `javascript/`)::
 *
 *     set -a; . ../python/.env; set +a
 *     TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER_2 \
 *     SCENARIO_TWILIO_EXTERNAL_TO=$TWILIO_PHONE_NUMBER \
 *     SCENARIO_TWILIO_E2E_STT=elevenlabs \
 *     SCENARIO_TWILIO_E2E_MODEL=gemini/gemini-2.5-flash \
 *     SCENARIO_TWILIO_E2E_VOICE=elevenlabs/EXAVITQu4vr4xnSDxMaL \
 *     pnpm vitest run src/voice/adapters/__tests__/twilio-a-leg-external.e2e.test.ts
 *
 * Provider overrides (all optional; defaults are the OpenAI stack, mirroring the
 * Python test's documented defaults)::
 *
 *     SCENARIO_TWILIO_E2E_VOICE=elevenlabs/<voice_id>   # user-simulator TTS
 *     SCENARIO_TWILIO_E2E_STT=elevenlabs                 # transcription of callee audio
 *     SCENARIO_TWILIO_E2E_MODEL=gemini/gemini-2.5-flash  # user-simulator + judge LLM
 *
 * Binds AC11 of `specs/voice-twilio-a-leg-external.feature`.
 */
import { resolve4 } from "node:dns/promises";

import { describe, it, expect } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, ModelMessage } from "ai";

import { userSimulatorAgent, judgeAgent } from "../../../agents";
import type { ScriptStep } from "../../../domain";
import { run } from "../../../runner";
import { agent, judge, user } from "../../../script";
import type { VoiceConfig } from "../../config";
import { ElevenLabsSTTProvider } from "../../stt";
import { TwilioAgentAdapter } from "../twilio";
import { TunnelNotReadyError, type TunnelReadiness } from "../twilio-shared";
import { openTwilioTunnel } from "../twilio-tunnel";

/** The four env vars that must all be present for the live call to run. */
const REQUIRED_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SCENARIO_TWILIO_EXTERNAL_TO",
] as const;
const ENABLED = REQUIRED_ENV.every((k) => Boolean(process.env[k]));

/** What the user simulator opens with. Its audio must leave on `sendAudio` and
 * the callee's spoken reply must come back — the two halves AC11 asks for. */
const OUTBOUND_PROMPT = "Hello, I am calling to test this line. Can you hear me?";

/** Ceiling on a billed external call. Belt (adapter timer) and suspenders
 * (Twilio TimeLimit) both derive from this. Kept low — this is a real PSTN call. */
const MAX_CALL_DURATION_SECONDS = 45;

/** The suite default is 20s; this test legitimately outlives it (up to a 120s
 * stream-connect wait + the call + LLM turns). The adapter's own guards
 * (stream-connect timeout, max_call_duration, Twilio TimeLimit) are the real
 * ceilings — this only has to sit above them. */
const TEST_TIMEOUT_MS = 600_000;

/** Fixed local port — the cloudflared tunnel is opened against it before the
 * adapter binds it (a 502 until the origin connects is expected, and the
 * readiness probe below waits it out). */
const HTTP_PORT = 8767;

/**
 * Resolve a litellm-style `"provider/model"` spec to an AI-SDK `LanguageModel`.
 *
 * The JS package ships only `@ai-sdk/openai` and has no litellm, so a bare
 * `"gemini/…"` string would route to the (unauthenticated) AI Gateway. We map
 * the two providers whose keys the operator actually holds to direct-auth model
 * instances: OpenAI natively, and Gemini through Google's OpenAI-compatible
 * endpoint with `GEMINI_API_KEY` — the direct twin of litellm's `"gemini/"`
 * route. Any other prefix is handed to the AI Gateway as a raw string.
 */
function resolveModel(spec: string): LanguageModel {
  const slash = spec.indexOf("/");
  const provider = slash === -1 ? "openai" : spec.slice(0, slash);
  const id = slash === -1 ? spec : spec.slice(slash + 1);
  if (provider === "gemini" || provider === "google") {
    return createOpenAI({
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: process.env.GEMINI_API_KEY ?? "",
    }).chat(id);
  }
  if (provider === "openai") {
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" }).chat(id);
  }
  return spec;
}

/** Flatten a `ModelMessage`'s content to plain text for the transcript check. */
function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * Does this message carry an audio part? The callee's reply comes back as raw
 * PCM the a-leg socket decoded; the voice runtime records it as an AI-SDK `file`
 * part (`mediaType: "audio/…"`), and its STT transcript is produced lazily by
 * the judge, so the stored assistant turn is audio, not text. Its presence is
 * the "the return direction carried audio" evidence in message form.
 */
function hasAudioPart(message: ModelMessage): boolean {
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part != null &&
        typeof part === "object" &&
        "mediaType" in part &&
        String((part as { mediaType?: unknown }).mediaType ?? "").startsWith("audio"),
    )
  );
}

/** Resolve `host`'s A record via a DNS-over-HTTPS resolver; `null` if unresolved. */
async function dohResolve(endpoint: string, host: string): Promise<string | null> {
  const url = new URL(endpoint);
  url.searchParams.set("name", host);
  url.searchParams.set("type", "A");
  const res = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5_000),
  });
  const data = (await res.json()) as {
    Status?: number;
    Answer?: Array<{ data?: string }>;
  };
  if (data.Status === 0 && data.Answer && data.Answer.length > 0) {
    return data.Answer[0].data ?? null;
  }
  return null;
}

/**
 * A {@link TunnelReadiness} over a cloudflared quick tunnel: wait until the fresh
 * `*.trycloudflare.com` hostname is GLOBALLY RESOLVABLE.
 *
 * Faithful twin of Python's `CloudflareTunnel.wait_until_edge_reachable()`: it
 * races Cloudflare DoH, Google DoH and the system resolver and returns the
 * instant ANY of them answers with an A record. It deliberately does NOT do an
 * HTTP round-trip — a fresh hostname is announced before DNS propagates, so
 * dialing into that gap makes Twilio fetch TwiML too early and drop the call at
 * duration 0. Resolution (not a local GET) is the right gate here because this
 * host's own HTTPS egress to the Cloudflare edge can be filtered even while
 * Twilio's path to the same tunnel is clean; the DNS answer is what proves
 * Twilio will find it.
 */
function edgeReadiness(baseUrl: string): TunnelReadiness {
  const host = baseUrl
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return {
    async waitUntilEdgeReachable(): Promise<void> {
      const deadlineMs = Date.now() + 300_000;
      let last = "";
      while (Date.now() < deadlineMs) {
        try {
          await Promise.any([
            dohResolve("https://cloudflare-dns.com/dns-query", host).then((result) => {
              if (!result) throw new Error("no answer");
              return result;
            }),
            dohResolve("https://dns.google/resolve", host).then((result) => {
              if (!result) throw new Error("no answer");
              return result;
            }),
            resolve4(host).then((a) => {
              const result = a[0] ?? null;
              if (!result) throw new Error("no answer");
              return result;
            }),
          ]);
          return;
        } catch (err) {
          if (!(err instanceof AggregateError)) {
            throw err;
          }
          last =
            (err.errors as Array<Error>)
              .map((e) => (e instanceof Error ? e.message : String(e)))
              .join(", ") || "no resolver responded";
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      throw new TunnelNotReadyError(
        `tunnel ${baseUrl} did not become globally resolvable within 300s (last: ${last})`,
      );
    },
  };
}

// `describe.skip` when the creds/destination are absent: the block reports a
// single skipped test instead of a vacuous pass, and CI never dials.
const describeMaybe = ENABLED ? describe : describe.skip;

describeMaybe("Twilio a-leg external live e2e (set TWILIO_* + SCENARIO_TWILIO_EXTERNAL_TO)", () => {
  it(
    "AC11 - a-leg dials an external number and audio flows in both directions",
    async () => {
      const externalTo = process.env.SCENARIO_TWILIO_EXTERNAL_TO!;
      const voice = process.env.SCENARIO_TWILIO_E2E_VOICE ?? "openai/nova";
      const model = resolveModel(
        process.env.SCENARIO_TWILIO_E2E_MODEL ?? "openai/gpt-4.1-mini",
      );
      // Mirror the Python fixture's optional ElevenLabs STT override — passed as
      // the per-run voice config (ADR-002), not a process-wide global.
      const voiceConfig: VoiceConfig | undefined =
        process.env.SCENARIO_TWILIO_E2E_STT === "elevenlabs"
          ? { stt: new ElevenLabsSTTProvider() }
          : undefined;

      const framesSeen: number[] = [];
      const tunnel = await openTwilioTunnel({
        port: HTTP_PORT,
        provider: "cloudflared",
      });
      let adapter: TwilioAgentAdapter | undefined;
      try {
        adapter = new TwilioAgentAdapter({
          accountSid: process.env.TWILIO_ACCOUNT_SID!,
          authToken: process.env.TWILIO_AUTH_TOKEN!,
          phoneNumber: process.env.TWILIO_PHONE_NUMBER!,
          publicBaseUrl: tunnel.url,
          // Deny-by-default (#762 guardrail (c)): the destination the operator
          // named in env is the only number this adapter may dial.
          allowedCallees: [externalTo],
          // The harness owns the tunnel, so it is the one thing that can answer
          // "is our public URL live yet?" for a-leg origination.
          tunnelReadiness: edgeReadiness(tunnel.url),
          httpPort: HTTP_PORT,
          validateSignature: false,
        });
        await adapter.connect();
        await adapter.placeCall({
          to: externalTo,
          attachStream: "a-leg",
          timeoutMs: 120_000,
          maxCallDurationSeconds: MAX_CALL_DURATION_SECONDS,
        });

        const boundAdapter = adapter;
        const sampleFrames: ScriptStep = (_state) => {
          // Must run inside the script: run() disconnects every voice adapter on
          // the way out, and disconnect() zeroes the counters.
          framesSeen.push(boundAdapter._framesReceivedForTest);
        };

        const result = await run(
          {
            name: "twilio_a_leg_external_smoke",
            description:
              "The adapter dials an external number and attaches the Media " +
              "Stream to its own leg via <Connect><Stream>. The user simulator " +
              "speaks over that stream and the callee's replies come back on it.",
            agents: [
              adapter,
              userSimulatorAgent({ voice, model }),
              judgeAgent({
                model,
                criteria: [
                  "The callee received the caller's spoken audio",
                  "The callee's spoken reply came back over the media stream",
                  "The call completed without transport errors",
                ],
              }),
            ],
            script: [user(OUTBOUND_PROMPT), agent(), sampleFrames, judge()],
            maxTurns: 4,
          },
          voiceConfig ? { voice: voiceConfig } : undefined,
        );

        // Bidirectional evidence, not "audio was heard": frames_received counts
        // the inbound media frames the a-leg socket actually decoded, and the
        // transcribed assistant turns are the STT read of that same audio.
        const framesReceived = framesSeen.length
          ? framesSeen[framesSeen.length - 1]
          : 0;
        // eslint-disable-next-line no-console
        console.log(`a-leg e2e: frames_received=${framesReceived}`);
        expect(
          framesReceived,
          "no inbound media frames decoded — the a-leg socket carried no audio",
        ).toBeGreaterThan(0);

        // The callee's reply came back on the stream: an assistant turn carries
        // either the STT transcript (when attached) or the decoded audio itself.
        const replies = result.messages.filter(
          (m) =>
            m.role === "assistant" &&
            (messageText(m).trim().length > 0 || hasAudioPart(m)),
        );
        expect(
          replies.length,
          "no reply from the callee captured on the stream — the return direction is unproven",
        ).toBeGreaterThan(0);

        expect(
          result.success,
          `Expected success; verdict: ${result.reasoning}`,
        ).toBe(true);
      } finally {
        if (adapter) {
          try {
            await adapter.disconnect();
          } catch {
            // Best-effort teardown; the assertions above own the verdict.
          }
        }
        try {
          await tunnel.close();
        } catch {
          // Best-effort.
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
