/**
 * Model provider for the end-to-end proof.
 *
 * Defaults to OpenAI (`gpt-5-mini`) so a reviewer with an `OPENAI_API_KEY` just runs it.
 * Set `SC779_PROVIDER=gemini` to route through Gemini's OpenAI-compatible endpoint using
 * `GEMINI_API_KEY` — this needs no extra provider dependency (it reuses `@ai-sdk/openai`),
 * so the proof runs against whichever funded key is available. Override the model id with
 * `SC779_MODEL`.
 */
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const PROVIDER = (process.env.SC779_PROVIDER ?? "openai").toLowerCase();
const isGemini = PROVIDER === "gemini" || PROVIDER === "google";
if (!isGemini && PROVIDER !== "openai") {
  throw new Error(`Unsupported SC779_PROVIDER="${PROVIDER}" — use "openai" (default), "gemini", or "google".`);
}

export const E2E_MODEL_ID =
  process.env.SC779_MODEL ?? (isGemini ? "gemini-2.5-flash" : "gpt-5-mini");

export const E2E_MODEL_LABEL = `${PROVIDER}:${E2E_MODEL_ID}`;

export function e2eModel(): LanguageModel {
  if (isGemini) {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error("SC779_PROVIDER=gemini but neither GEMINI_API_KEY nor GOOGLE_GENERATIVE_AI_API_KEY is set");
    // Gemini exposes an OpenAI-compatible Chat Completions endpoint (incl. function calling),
    // so the already-installed @ai-sdk/openai provider drives it with just a baseURL swap.
    const gemini = createOpenAI({ baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey });
    // Force the Chat Completions API: Gemini's OpenAI-compat layer implements /chat/completions,
    // not the Responses API that @ai-sdk/openai's bare provider(id) defaults to.
    return gemini.chat(E2E_MODEL_ID);
  }
  return openai(E2E_MODEL_ID);
}
