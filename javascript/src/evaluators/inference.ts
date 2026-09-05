/**
 * Infers where an unmapped evaluator input reads from, by its name, and
 * produces the state callable that reads it. Mirrors the rules the LangWatch
 * platform applies when an evaluator is attached to a test suite, so a
 * scenario in code and a scenario on the platform map the same inputs the
 * same way.
 *
 * - `input`, `question`, `user_input` read the first user message
 * - `output`, `response`, `answer` read the last agent message
 * - `transcript`, `conversation`, `messages` read the transcript
 * - `contexts`, `retrieved_contexts` read the retrieved contexts of the trace
 * - an expected-like input (`expected_*`, `golden`, `reference`,
 *   `ground_truth`) reads the one field whose name shares a word with it
 * - a tool call is never inferred
 */
import type { EvaluatorMapping } from "../domain";
import { conversation, field, trace, type StateMapping } from "./mappings";

const CONVERSATION_INPUTS: Record<string, StateMapping> = {
  input: conversation.firstUserMessage,
  question: conversation.firstUserMessage,
  user_input: conversation.firstUserMessage,
  output: conversation.lastAgentMessage,
  response: conversation.lastAgentMessage,
  answer: conversation.lastAgentMessage,
  transcript: conversation.transcript,
  conversation: conversation.transcript,
  messages: conversation.transcript,
  contexts: trace.contexts,
  retrieved_contexts: trace.contexts,
};

const EXPECTED_LIKE_PREFIXES = ["expected_", "golden", "reference", "ground_truth"];

/**
 * The field name words each expected-like input accepts. An input not listed
 * here accepts the words of its own name, `expected` removed.
 */
const EXPECTED_INPUT_WORDS: Record<string, string[]> = {
  expected_output: [
    "expected",
    "golden",
    "reference",
    "answer",
    "sql",
    "query",
    "label",
    "target",
  ],
  expected_contexts: ["schema", "schemas", "context", "contexts", "table", "tables"],
};

export function isExpectedLikeInput(inputId: string): boolean {
  const id = inputId.toLowerCase();
  return EXPECTED_LIKE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function words(identifier: string): string[] {
  return identifier
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function inferField({
  inputId,
  fieldNames,
}: {
  inputId: string;
  fieldNames: string[];
}): StateMapping | undefined {
  if (fieldNames.length === 0) return undefined;
  if (fieldNames.length === 1) return field(fieldNames[0]);

  const accepted = new Set(
    EXPECTED_INPUT_WORDS[inputId.toLowerCase()] ??
      words(inputId).filter((word) => word !== "expected")
  );
  const candidates = fieldNames.filter((name) =>
    words(name).some((word) => accepted.has(word))
  );
  return candidates.length === 1 ? field(candidates[0]) : undefined;
}

/**
 * Completes the mappings of an evaluator: explicit mappings stay as they are,
 * every other input the evaluator declares is inferred from its name, and an
 * input that cannot be inferred stays unmapped.
 */
export function inferEvaluatorMappings({
  inputs,
  fieldNames,
  mappings = {},
}: {
  inputs: string[];
  fieldNames: string[];
  mappings?: Record<string, EvaluatorMapping>;
}): Record<string, EvaluatorMapping> {
  const result: Record<string, EvaluatorMapping> = { ...mappings };
  for (const inputId of inputs) {
    if (result[inputId] !== undefined) continue;
    const inferred = isExpectedLikeInput(inputId)
      ? inferField({ inputId, fieldNames })
      : CONVERSATION_INPUTS[inputId.toLowerCase()];
    if (inferred) result[inputId] = inferred;
  }
  return result;
}
