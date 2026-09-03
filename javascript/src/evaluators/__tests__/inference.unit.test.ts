// Ref: specs/scenario-evaluators.feature
import { describe, it, expect } from "vitest";
import { inferEvaluatorMappings, isExpectedLikeInput } from "../inference";
import { conversation, field, trace, value } from "../mappings";

describe("evaluator mapping inference", () => {
  describe("given the mapping helpers", () => {
    // Scenario: Mapping helpers build the platform mapping shape
    it("builds the source mapping the platform stores", () => {
      expect(conversation.firstUserMessage).toEqual({
        type: "source",
        sourceId: "conversation",
        path: ["first_user_message"],
      });
      expect(field("golden_sql")).toEqual({
        type: "source",
        sourceId: "scenario",
        path: ["fields", "golden_sql"],
      });
      expect(trace.toolCall("run_sql").input).toEqual({
        type: "source",
        sourceId: "trace",
        path: ["tool_calls", "run_sql", "input"],
      });
      expect(trace.toolCall("run_sql").output.path).toEqual([
        "tool_calls",
        "run_sql",
        "output",
      ]);
      expect(trace.contexts.path).toEqual(["contexts"]);
    });

    it("builds a literal value mapping", () => {
      expect(value("42")).toEqual({ type: "value", value: "42" });
    });
  });

  describe("given an evaluator with conversation inputs and no mappings", () => {
    // Scenario: Unmapped conversation inputs are inferred by name
    describe("when the mappings are inferred", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["input", "output", "contexts"],
        fieldNames: [],
      });

      it("maps input to the first user message", () => {
        expect(mappings.input).toEqual(conversation.firstUserMessage);
      });

      it("maps output to the last agent message", () => {
        expect(mappings.output).toEqual(conversation.lastAgentMessage);
      });

      it("maps contexts to the retrieved contexts of the trace", () => {
        expect(mappings.contexts).toEqual(trace.contexts);
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

      it("maps expected_output to golden_sql", () => {
        expect(mappings.expected_output).toEqual(field("golden_sql"));
      });

      it("maps expected_contexts to table_schema", () => {
        expect(mappings.expected_contexts).toEqual(field("table_schema"));
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
      expect(mappings.expected_answer).toEqual(field("truth"));
    });
  });

  describe("given an output input and a run_sql tool call in the messages", () => {
    // Scenario: A tool call source is never inferred
    it("maps output to the conversation, not to the tool call", () => {
      const mappings = inferEvaluatorMappings({
        inputs: ["output"],
        fieldNames: [],
      });
      expect(mappings.output).toEqual(conversation.lastAgentMessage);
    });
  });

  describe("given an explicit tool call mapping", () => {
    // Scenario: An explicit mapping wins over inference
    it("keeps the explicit mapping", () => {
      const explicit = trace.toolCall("run_sql").input;
      const mappings = inferEvaluatorMappings({
        inputs: ["output"],
        fieldNames: [],
        mappings: { output: explicit },
      });
      expect(mappings.output).toBe(explicit);
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
