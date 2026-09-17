// Ref: specs/scenario-evaluators.feature
import { describe, it, expect } from "vitest";
import { inferEvaluatorMappings, isExpectedLikeInput } from "../inference";
import { conversation, field, trace, type StateMapping } from "../mappings";

function expression(mapping: unknown): string | undefined {
  return (mapping as StateMapping | undefined)?.expression;
}

describe("evaluator mapping inference", () => {
  describe("given an evaluator with conversation inputs and no mappings", () => {
    // Scenario: Unmapped conversation inputs are inferred by name
    describe("when the mappings are inferred", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["input", "output", "contexts"],
        fieldNames: [],
      });

      it("maps input to the first user message of the state", () => {
        expect(mappings.input).toBe(conversation.firstUserMessage);
        expect(expression(mappings.input)).toBe("state.firstUserMessage() || undefined");
      });

      it("maps output to the last agent message of the state", () => {
        expect(mappings.output).toBe(conversation.lastAgentMessage);
      });

      it("maps contexts to the retrieved contexts of the state", () => {
        expect(mappings.contexts).toBe(trace.contexts);
        expect(expression(mappings.contexts)).toBe("state.contexts");
      });
    });
  });

  describe("given the fields golden_sql and table_schema", () => {
    // Scenario: An expected-like input is inferred to a field by its name words
    describe("when expected-like inputs are inferred", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["output", "expected_output", "expected_contexts"],
        fieldNames: ["golden_sql", "table_schema"],
      });

      it("maps expected_output to the field golden_sql", () => {
        expect(expression(mappings.expected_output)).toBe(field("golden_sql").expression);
      });

      it("maps expected_contexts to the field table_schema", () => {
        expect(expression(mappings.expected_contexts)).toBe(field("table_schema").expression);
      });
    });
  });

  describe("given two candidate fields for one expected-like input", () => {
    // Scenario: An expected-like input with several candidate fields stays unmapped
    it("leaves the input unmapped", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["expected_output"],
        fieldNames: ["golden_sql", "reference_sql"],
      });
      expect(mappings.expected_output).toBeUndefined();
    });
  });

  describe("given one field only", () => {
    it("maps an expected-like input to that field", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["expected_answer"],
        fieldNames: ["truth"],
      });
      expect(expression(mappings.expected_answer)).toBe('state.field("truth")');
    });
  });

  describe("given an output input and a run_sql tool call in the messages", () => {
    // Scenario: A tool call source is never inferred
    it("maps output to the last agent message, not to the tool call", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["output"],
        fieldNames: [],
      });
      expect(mappings.output).toBe(conversation.lastAgentMessage);
    });
  });

  describe("given an explicit mapping", () => {
    // Scenario: An explicit mapping wins over inference
    it("keeps the function the author wrote", () => {
      const explicit = (state: { toolCalls(name: string): { last?: { input: unknown } } }) =>
        state.toolCalls("run_sql").last?.input;
      const mappings = inferEvaluatorMappings({
        inputs: ["output"],
        fieldNames: [],
        mappings: { output: explicit },
      });
      expect(mappings.output).toBe(explicit);
    });

    it("keeps a literal the author wrote", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["language"],
        fieldNames: [],
        mappings: { language: "en" },
      });
      expect(mappings.language).toBe("en");
    });
  });

  describe("given input names", () => {
    it("recognizes expected-like inputs", () => {
      expect(isExpectedLikeInput("expected_output")).toBe(true);
      expect(isExpectedLikeInput("golden_answer")).toBe(true);
      expect(isExpectedLikeInput("reference")).toBe(true);
      expect(isExpectedLikeInput("ground_truth")).toBe(true);
      expect(isExpectedLikeInput("output")).toBe(false);
    });
  });
});
