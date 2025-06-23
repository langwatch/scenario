# Vitest Examples for @langwatch/scenario

This directory contains examples of using [@langwatch/scenario](https://github.com/langwatch/scenario) with [Vitest](https://vitest.dev/) for testing AI agents through scenarios.

## Getting Started

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create a `.env` file with your API keys if needed (for examples that use external LLM providers).

  ```bash
  echo "OPENAI_API_KEY=..." > .env
  ```

3. Run the examples:
   ```bash
   pnpm test
   ```

## Why Vitest instead of Jest?

We chose Vitest as our preferred testing framework for several reasons:

1. **ESM Compatibility**: Jest has historically struggled with ESM modules, TypeScript, and various configuration issues. Vitest offers native ESM support without complex workarounds.

2. **TypeScript Support**: Vitest works with TypeScript out of the box with minimal configuration.

3. **Speed**: Vitest leverages Vite's architecture for significantly faster test execution and development experience.

4. **Simplicity**: Setting up and configuring Vitest is straightforward, especially for modern JavaScript/TypeScript projects.

5. **Jest Compatibility**: Vitest maintains an API compatible with Jest, making migration straightforward. Most tests written for Jest can run with minimal changes in Vitest.

While we recommend Vitest, the `@langwatch/scenario` library itself is testing framework agnostic. You can use it with Jest or other testing frameworks with appropriate configuration.

## Example Scenarios

This directory includes the following example test scenarios:

- **simple-example.spec.ts**: A minimal example showing how to test a basic echo agent
- **vegetarian-recipe-example.spec.ts**: Tests an AI agent that generates vegetarian recipes
- **too-verbose-recipe-fail-example.spec.ts**: Demonstrates a failing test scenario
- **false-assumptions.test.ts**: Demonstrates a more complex scenario with a user simulator, a judge agent, and a declarative script.

## Key Concepts

Each example demonstrates these core concepts:

1.  Implementing the `AgentAdapter` interface for your agent.
2.  Defining a test case with `scenario.run`, including description, agents, and a script.
3.  Using specialized agents like `scenario.judgeAgent` for evaluation and `scenario.userSimulatorAgent` for simulating user behavior.
4.  Controlling the conversation flow with a declarative `script`.
5.  Asserting the success of the scenario using Vitest's `expect`.

## Example Usage

```typescript
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

// Implement your agent adapter
const myAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // A simple echo agent
    const lastUserMessage = input.messages[input.messages.length - 1];
    return `You said: ${lastUserMessage.content}`;
  },
};

describe("My Agent Test", () => {
  it("should handle basic interactions", async () => {
    const result = await scenario.run({
      name: "Basic Echo Interaction",
      description: "Test that the agent echoes back the user's message.",
      agents: [
        myAgent,
        scenario.judgeAgent({
          criteria: ["The agent should echo the user's message correctly."],
        }),
        scenario.userSimulatorAgent(),
      ],
      maxTurns: 2,
      verbose: process.env.VERBOSE === "true",
      script: [
        scenario.user("Hello agent!"),
        scenario.agent(), // Agent will respond
        scenario.judge(),
      ],
    });

    // Assert results
    expect(result.success).toBe(true);
  });
});
```

## Configuration

Set the `VERBOSE=true` environment variable when running tests to see detailed output:

```bash
VERBOSE=true pnpm test
```

Or use the included script:

```bash
pnpm run test
```

This script uses dotenv-cli to load environment variables from your .env file.
