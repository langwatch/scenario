import { ModelMessage } from "ai";
import { AgentReturnTypes } from "../domain";

/**
 * Utility functions for scenario execution.
 */
export const ScenarioExecutionUtils = {
  /**
   * Converts agent return types to ModelMessage format.
   *
   * This utility function handles the various return types that agents can return
   * and converts them to a standardized ModelMessage format. Agents can return:
   * - A string (converted to a message with the specified role)
   * - An array of ModelMessage objects (returned as-is)
   * - A single ModelMessage object (wrapped in an array)
   * - Any other type (returns empty array)
   *
   * @param response - The response from an agent (string, ModelMessage, or array of ModelMessage)
   * @param role - The role to assign if the response is a string ("user" or "assistant")
   * @returns An array of ModelMessage objects
   */
  convertAgentReturnTypesToMessages(
    response: AgentReturnTypes,
    role: "user" | "assistant"
  ): ModelMessage[] {
    if (typeof response === "string")
      return [{ role, content: response } as ModelMessage];

    if (Array.isArray(response)) return response;

    if (response && typeof response === "object" && "role" in response)
      return [response];

    return [];
  },

  /**
   * Extracts structured error information for logging and reporting.
   *
   * This function takes any thrown error (unknown type) and returns an object
   * containing the error's name, message, and stack trace if available.
   * If the input is not an instance of Error, it provides a generic name and
   * stringified value for message.
   *
   * @param error - The error object or value to extract information from.
   * @returns An object with 'name', optional 'message', and optional 'stack' properties.
   */
  extractErrorInfo(error: unknown): {
    name: string;
    message?: string;
    stack?: string;
  } {
    // Extracts error information in a structured way for logging and reporting.
    // Returns an object with name, message, and stack if available.
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    // If not an Error instance, provide a generic name and stringified value.
    return {
      name: typeof error,
      message: String(error),
    };
  },
};
