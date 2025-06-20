# Scenario

![scenario](../assets/scenario-wide.webp)


[![npm version](https://badge.fury.io/js/%40getscenario%2Fscenario.svg)](https://badge.fury.io/js/%40getscenario%2Fscenario)

A powerful TypeScript library for testing AI agents in realistic, scripted scenarios.

Scenario provides a declarative DSL for defining test cases, allowing you to control conversation flow, simulate user behavior, and evaluate agent performance against predefined criteria.

## Features

- **Declarative DSL**: Write clear and concise tests with a simple, powerful scripting language.
- **Realistic Simulation**: Use the `userSimulatorAgent` to generate natural user interactions.
- **Automated Evaluation**: Employ the `judgeAgent` to automatically assess conversations against success criteria.
- **Flexible & Extensible**: Easily integrate any AI agent that conforms to a simple `AgentAdapter` interface.
- **Detailed Reporting**: Get rich results including conversation history, success/failure reasoning, and performance metrics.
- **TypeScript First**: Full type safety and autocompletion in your editor.

## Installation

```bash
pnpm add @getscenario/scenario
# or
npm install @getscenario/scenario
# or
yarn add @getscenario/scenario
```

## Quick Start

Create your first scenario test in under a minute.

```typescript
// echo.test.ts
import { run, AgentRole, AgentAdapter, user, agent, succeed } from "@getscenario/scenario";

// 1. Create an adapter for your agent
const echoAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // This agent simply echoes back the last message content
    const lastMessage = input.messages[input.messages.length - 1];
    return `You said: ${lastMessage.content}`;
  },
};

// 2. Define and run your scenario
async function testEchoAgent() {
  const result = await run({
    name: "Echo Agent Test",
    description: "The agent should echo back the user's message.",
    agents: [echoAgent],
    script: [
      user("Hello world!"),
      agent("You said: Hello world!"), // You can assert the agent's response directly
      succeed("Agent correctly echoed the message."),
    ],
  });

  if (result.success) {
    console.log("✅ Scenario passed!");
  } else {
    console.error(`❌ Scenario failed: ${result.reasoning}`);
  }
}

testEchoAgent();
```

## Usage with a Test Runner

Scenario integrates seamlessly with test runners like [Vitest](https://vitest.dev/) or [Jest](https://jestjs.io/). Here's a more advanced example testing an AI-powered weather agent.

```typescript
// weather.test.ts
import { describe, it, expect } from "vitest";
import { openai } from "@ai-sdk/openai";
import { run, userSimulatorAgent, AgentRole, AgentAdapter, user, agent, succeed } from "@getscenario/scenario";
import { generateText, tool } from "ai";
import { z } from "zod";

describe("Weather Agent", () => {
  it("should get the weather for a city", async () => {
    // 1. Define the tools your agent can use
    const getCurrentWeather = tool({
      description: "Get the current weather in a given city.",
      parameters: z.object({
        city: z.string().describe("The city to get the weather for."),
      }),
      execute: async ({ city }) => `The weather in ${city} is cloudy with a temperature of 24°C.`,
    });

    // 2. Create an adapter for your agent
    const weatherAgent: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        const response = await generateText({
          model: openai("gpt-4.1-mini"),
          system: `You are a helpful assistant that may help the user with weather information.`,
          messages: input.messages,
          tools: { get_current_weather: getCurrentWeather },
        });

        if (response.toolCalls?.length) {
          // For simplicity, we'll just return the arguments of the first tool call
          const { toolName, args } = response.toolCalls[0];
          return {
            role: "tool",
            content: [{ type: "tool-result", toolName, result: args }],
          };
        }

        return response.text;
      },
    };

    // 3. Define and run your scenario
    const result = await run({
      name: "Checking the weather",
      description: "The user asks for the weather in a specific city, and the agent should use the weather tool to find it.",
      agents: [
        weatherAgent,
        userSimulatorAgent({ model: openai("gpt-4.1-mini") }),
      ],
      script: [
        user("What's the weather like in Barcelona?"),
        agent(),
        // You can use inline assertions within your script
        (state) => {
          expect(state.hasToolCall("get_current_weather")).toBe(true);
        },
        succeed("Agent correctly used the weather tool."),
      ],
    });

    // 4. Assert the final result
    expect(result.success).toBe(true);
  });
});
```

## Core Concepts

### `run(config)`

The main function to execute a scenario. It takes a configuration object and returns a promise that resolves with the final `ScenarioResult`.

### `ScenarioConfig`

The configuration object for a scenario.

- `name: string`: A human-readable name for the scenario.
- `description: string`: A detailed description of what the scenario tests.
- `agents: AgentAdapter[]`: A list of agents participating in the scenario.
- `script?: ScriptStep[]`: An optional array of steps to control the scenario flow. If not provided, the scenario will proceed automatically.
- `maxTurns?: number`: The maximum number of conversation turns before a timeout. Defaults to 10.
- `verbose?: boolean`: Enables detailed logging during execution.

### Agents

Agents are the participants in a scenario. They are defined by the `AgentAdapter` interface.

```typescript
export interface AgentAdapter {
  role: AgentRole; // USER, AGENT, or JUDGE
  call: (input: AgentInput) => Promise<AgentReturnTypes>;
}
```

Scenario provides built-in agents for common testing needs:

- `userSimulatorAgent(config)`: Simulates a human user, generating realistic messages based on the scenario description.
- `judgeAgent(config)`: Evaluates the conversation against a set of criteria and determines if the scenario succeeds or fails.

### Scripting

Scripts provide fine-grained control over the scenario's execution. A script is an array of `ScriptStep` functions.

A `ScriptStep` is a function that receives the current `ScenarioExecutionState` and the `ScenarioExecutionLike` context.

**Built-in Script Steps:**

- `user(content?)`: A user turn. If `content` is provided, it's used as the message. Otherwise, the `userSimulatorAgent` generates one.
- `agent(content?)`: An agent turn. If `content` is provided, it's used as the message. Otherwise, the agent under test generates a response.
- `judge(content?)`: Forces the `judgeAgent` to make a decision.
- `message(message)`: Adds a specific `CoreMessage` to the conversation.
- `proceed(turns?, onTurn?, onStep?)`: Lets the scenario run automatically.
- `succeed(reasoning?)`: Ends the scenario with a success verdict.
- `fail(reasoning?)`: Ends the scenario with a failure verdict.

You can also provide your own functions as script steps for making assertions:

```typescript
import { expect } from "vitest";

const script = [
  user("Hello"),
  agent(),
  (state) => {
    // Make assertions on the state
    expect(state.lastAssistantMessage?.content).toContain("Hi there");
  },
  succeed(),
];
```

## Configuration

You can configure project-wide defaults by creating a `scenario.config.js` or `scenario.config.mjs` file in your project root.

```js
// scenario.config.mjs
import { defineConfig } from "@getscenario/scenario/config";
import { openai } from "@ai-sdk/openai";

export default defineConfig({
  // Set a default model provider for all agents (e.g., userSimulatorAgent, judgeAgent)
  defaultModel: {
    model: openai("gpt-4o-mini"),
    temperature: 0.1,
  },

  // Configure the LangWatch reporting endpoint and API key
  langwatchEndpoint: "https://app.langwatch.ai",
  langwatchApiKey: process.env.LANGWATCH_API_KEY,
});
```

The library will automatically load this configuration.

### All Configuration Options

The following configuration options are all optional. You can specify any combination of them in your `scenario.config.js` file.

- `defaultModel` _(Optional)_: An object to configure the default AI model for all agents.
  - `model`: **(Required if `defaultModel` is set)** An instance of a language model from a provider like `@ai-sdk/openai`.
  - `temperature` _(Optional)_: The default temperature for the model (e.g., `0.1`).
  - `maxTokens` _(Optional)_: The default maximum number of tokens for the model to generate.
- `langwatchEndpoint` _(Optional)_: The endpoint for the LangWatch reporting service. If not specified, it defaults to the `LANGWATCH_ENDPOINT` environment variable, or `https://app.langwatch.ai`.
- `langwatchApiKey` _(Optional)_: Your LangWatch API key for authenticating with the reporting service. If not specified, it defaults to the `LANGWATCH_API_KEY` environment variable.

### Environment Variables

You can control the library's behavior with the following environment variables:

- `SCENARIO_LOG_LEVEL`: Sets the verbosity of the internal logger. Can be `error`, `warn`, `info`, or `debug`. By default, logging is silent.
- `SCENARIO_DISABLE_SIMULATION_REPORT_INFO`: Set to `true` to disable the "Scenario Simulation Reporting" banner that is printed to the console when a test run starts.
- `LANGWATCH_API_KEY`: Your LangWatch API key. This is used as a fallback if `langwatchApiKey` is not set in your config file.
- `LANGWATCH_ENDPOINT`: The LangWatch reporting endpoint. This is used as a fallback if `langwatchEndpoint` is not set in your config file.

## Development

This project uses `pnpm` for package management.

### Getting Started

```bash
# Install dependencies
pnpm install

# Build the project
pnpm run build

# Run tests
pnpm test
```

## License

MIT
