import { ModelMessage } from "ai";
import { JudgeResult } from "../../../agents";

/**
 * The possible return types from an agent's `call` method.
 * - string | ModelMessage | ModelMessage[]: Agent generated response
 * - JudgeResult: Judge made a final decision
 * - null: Judge wants to continue observing (no decision yet)
 */
export type AgentReturnTypes =
  | string
  | ModelMessage
  | ModelMessage[]
  | JudgeResult
  | null;
