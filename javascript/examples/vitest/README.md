# Vitest Examples for @langwatch/scenario-ts

This directory contains examples of using [@langwatch/scenario-ts](https://github.com/langwatch/scenario-ts) with [Vitest](https://vitest.dev/) for testing AI agents through scenarios.

## Getting Started

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create a `.env` file with your API keys if needed (for examples that use external LLM providers).

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

While we recommend Vitest, the `@langwatch/scenario-ts` library itself is testing framework agnostic. You can use it with Jest or other testing frameworks with appropriate configuration.

## Example Scenarios

This directory includes the following example test scenarios:

- **simple-example.spec.ts**: A minimal example showing how to test a basic echo agent
- **vegetarian-recipe-example.spec.ts**: Tests an AI agent that generates vegetarian recipes
- **too-verbose-recipe-fail-example.spec.ts**: Demonstrates a failing test scenario

## Key Concepts

Each example demonstrates these core concepts:

1. Implementing the `TestableAgent` interface
2. Creating a `Scenario` with success and failure criteria
3. Running tests with Vitest's testing framework
4. Verifying results using Vitest assertions

## Example Usage

```typescript
import { Scenario, TestableAgent, Verdict } from "@langwatch/scenario-ts";
import { describe, it, expect } from "vitest";

// Implement your agent
class MyAgent implements TestableAgent {
  async invoke(message: string): Promise<{ message: string }> {
    return { message: `Response to: ${message}` };
  }
}

describe("My Agent Test", () => {
  it("should handle basic interactions", async () => {
    // Define your test scenario
    const scenario = new Scenario({
      description: "Test basic interaction",
      strategy: "Send a message and verify response",
      successCriteria: ["Agent responds with the original message"],
      failureCriteria: ["Agent fails to respond"],
    });

    // Create agent instance
    const agent = new MyAgent();

    // Run the scenario
    const result = await scenario.run({
      agent,
      maxTurns: 3,
      verbose: process.env.VERBOSE === "true",
    });

    // Assert results
    expect(result.verdict).toBe(Verdict.Success);
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
