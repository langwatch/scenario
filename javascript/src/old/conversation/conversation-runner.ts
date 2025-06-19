import { EventEmitter } from "events";
import { CoreMessage } from "ai";

import { MaxTurnsExceededError } from "./errors";
import type {
  ScenarioResult,
  TestableAgent,
  TestingAgent,
} from "../shared/types";

/**
 * ConversationRunner - Manages the conversation flow between a testable agent and a testing agent
 *
 * This class handles the back-and-forth interaction between agents, tracks messages,
 * and determines when a test scenario should conclude. It supports:
 * 1. Running conversations up to a maximum number of turns
 * 2. Handling different types of testing agent responses
 * 3. Collecting conversation history for result analysis
 * 4. Measuring total conversation time
 */
export class ConversationRunner {
  /** Stores the conversation history between agents */
  readonly messages: CoreMessage[] = [];
  /** Event emitter */
  private emitter = new EventEmitter();

  /**
   * Creates a new ConversationRunner instance
   *
   * @param config - Configuration options for the runner
   * @param config.agent - The agent being tested
   * @param config.testingAgent - The agent that simulates user behavior
   * @param config.maxTurns - Maximum number of conversation turns before ending
   * @param config.forceFinishTestMessage - Message to send when max turns reached
   */
  constructor(
    private config: {
      agent: TestableAgent;
      testingAgent: TestingAgent;
      maxTurns: number;
      forceFinishTestMessage: string;
    }
  ) {}

  on(event: "finish", listener: (result: ScenarioResult) => void): void;
  on(event: "messages", listener: (messages: CoreMessage[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: "finish" | "messages", listener: (data: any) => void): void {
    this.emitter.on(event, listener);
  }

  // Overload signatures
  off(event: "finish", listener: (result: ScenarioResult) => void): void;
  off(event: "messages", listener: (messages: CoreMessage[]) => void): void;
  // Implementation signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: "finish" | "messages", listener: (data: any) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Executes the conversation between agents until completion or max turns
   *
   * @returns A ScenarioResult containing test outcome, conversation history, and timing data
   */
  async run(): Promise<ScenarioResult> {
    const { maxTurns } = this.config;
    // Result of the test
    let result: Omit<ScenarioResult, "conversation"> | undefined;
    let turnCount = 0;

    while (turnCount < maxTurns) {
      turnCount++;
      //--------------------------------
      // Get the testing agent's response
      //--------------------------------
      const response = await this.config.testingAgent.invoke(this.messages, {
        onFinishTest: (response) => {
          result = response;
        },
      });

      // Record testing agent's message as "user" since it's simulating a user
      this.addMessage({ role: "user", content: response.text });

      // If we get a test result,
      // exit the loop and return the result
      if (result) {
        const finalResult = {
          ...result,
          conversation: this.messages,
        };
        this.emitter.emit("finish", finalResult);
        return finalResult;
      }

      //--------------------------------
      // Get the agent's response
      //--------------------------------
      const { text } = await this.config.agent.invoke(response.text);

      // Record the agent's message
      this.addMessage({ role: "assistant", content: text });
    }

    this.addMessage({
      role: "assistant",
      content: this.config.forceFinishTestMessage,
    });

    // If we get here, we've hit max turns
    // We need to give the testing agent a final chance to make a final verdict
    await this.config.testingAgent.invoke(this.messages);

    if (result) {
      const finalResult = {
        ...result,
        conversation: this.messages,
      };
      this.emitter.emit("finish", finalResult);
      return finalResult;
    }

    throw new MaxTurnsExceededError("Max turns exceeded");
  }

  private addMessage(message: CoreMessage) {
    this.messages.push(message);
    this.emitter.emit("messages", this.messages);
  }
}
