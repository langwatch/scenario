import { CoreMessage } from "ai";
import { JudgeResult } from "../../../agents";

/**
 * The possible return types from an agent's `call` method.
 * - string | CoreMessage | CoreMessage[]: Agent generated response
 * - JudgeResult: Judge made a final decision
 * - null: Judge wants to continue observing (no decision yet)
 */
export type AgentReturnTypes =
  | string
  | CoreMessage
  | CoreMessage[]
  | JudgeResult
  | null;
