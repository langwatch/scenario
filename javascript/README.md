# Scenario TS

A TypeScript library for testing AI agents using scenarios.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Documentation](#documentation)
  - [Architecture Decision Record](./docs/ADR-001-scenario-architecture.md)
  - [Style Guide](./docs/STYLE_GUIDE.md)
  - [Contributing Guide](./docs/CONTRIBUTING.md)
  - [Testing Guide](./docs/TESTING.md)
- [Development](#development)
  - [Getting Started](#getting-started)
  - [Working with Examples](#working-with-examples)
  - [Project Rules](#project-rules)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
- [License](#license)

## Installation

```bash
# Using pnpm (recommended)
pnpm add @langwatch/scenario-ts

# Using npm
npm install @langwatch/scenario-ts

# Using yarn
yarn add @langwatch/scenario-ts
```

## Usage

```typescript
import scenario, { TestableAgent } from "@langwatch/scenario-ts";

// Define your agent implementation
class MyAgent implements TestableAgent {
  async invoke(message: string): Promise<{ message: string }> {
    // Your agent implementation here
    return { message: "Response from the agent" };
  }
}

const agent = new MyAgent();

const result = await scenario.run({
  name: "vegetarian recipe agent",
  description: "User wants a vegetarian dinner recipe",
  agents: [
    agent,
    scenario.userSimulatorAgent(),
    scenario.judgeAgent({
      criteria: [
        "Recipe has step-by-step instructions",
        "Recipe does not contain meat or fish",
      ],
    })
  ],
  script: [
    scenario.message({ role: "user", content: "I want a vegetarian recipe" }),
    scenario.agent(),
    (scenarioState) => {
      expect(scenarioState.hasToolCall("recipe_web_search")).toBe(true);
      // or any traditional assertion here
    },
    scenario.user(),
    scenario.message({ role: "assistant", content: "I wont help you" }),
    scenario.proceed({ turns: 2 }),
    scenario.message({ role: "assistant", content: "Sorry, I had an issue" }),
    scenario.proceed(),
  ]
});

if (result.verdict === "success") {
  console.log("Test passed!");
} else {
  console.log("Test failed:", result.reasoning);
}
```

For more detailed examples, see the [examples directory](./examples/).

## Advanced Usage

You can define more complex scenarios with multiple agents, scripts, and assertions. For example:

```typescript
const result = await scenario.run({
  name: "vegetarian recipe agent",
  description: "User wants a vegetarian dinner recipe",
  agents: [
    agent,
    scenario.userSimulatorAgent(),
    scenario.judgeAgent({
      criteria: [
        "Recipe has step-by-step instructions",
        "Recipe does not contain meat or fish",
      ],
    })
  ],
  script: [
    scenario.message({ role: "user", content: "I want a vegetarian recipe" }),
    scenario.agent(),
    (scenarioState) => {
      expect(scenarioState.hasToolCall("recipe_web_search")).toBe(true);
      // or any traditional assertion here
    },
    scenario.user(),
    scenario.message({ role: "assistant", content: "I wont help you" }),
    scenario.proceed({ turns: 2 }),
    scenario.message({ role: "assistant", content: "Sorry, I had an issue" }),
    scenario.proceed(),
  ]
});
```

This allows you to:
- Name and describe your scenario
- Specify multiple agents (including user simulators and judges)
- Write flexible scripts with assertions and control flow

## Simple Usage (Legacy)

You can still use the simpler API for basic agent testing:

```typescript
const result = await scenario.run({
  agent,
  maxTurns: 5, // Maximum conversation turns (default: 2)
});
```

if (result.verdict === Verdict.Success) {
  console.log("Test passed!");
} else {
  console.log("Test failed:", result.reasoning);
}

## Documentation

- [Architecture Decision Record](./docs/ADR-001-scenario-architecture.md) - Overview of the library's architecture and design decisions
- [Style Guide](./docs/STYLE_GUIDE.md) - Coding standards and file structure patterns
- [Contributing Guide](./docs/CONTRIBUTING.md) - How to contribute to this project
- [Testing Guide](./docs/TESTING.md) - Testing approach, conventions, and best practices

## Development

This project uses pnpm for package management.

### Getting Started

```bash
# Install dependencies
pnpm install

# Build the project
pnpm run build

# Create a local package for testing
pnpm run buildpack

# Run tests
pnpm test

# Run example tests (requires buildpack step first)
pnpm run examples:vitest:run test
```

### Working with Examples

The examples in the `examples/` directory use the local package as a dependency. Before running these examples, you must:

1. Build the project: `pnpm run build`
2. Create a local package: `pnpm run buildpack`

This creates a `.tgz` file in the root directory that the examples use as their dependency source.

```bash
# Complete workflow to update and test examples
pnpm run build      # Build the library
pnpm run buildpack  # Package it for local use
pnpm run examples:vitest:run test # Run the example tests
```

### Project Rules

This project follows these key development rules:

- Always use pnpm (never npm/yarn)
- Package is published as @langwatch/scenario-ts
- Build both CommonJS and ESM modules
- Examples must use @langwatch/scenario-ts import
- Keep dist/ in .gitignore

## Configuration

### Environment Variables

- `VERBOSE=true`: Enables detailed output of the conversation flow and generates a pretty report. This is useful for debugging and understanding how your agent interacts with the testing scenario.

Example:

```bash
# Run with verbose output
VERBOSE=true pnpm run examples:vitest:run test
```

### Project Config File

You can configure project-wide defaults by creating a `scenario.config.js` or `scenario.config.mjs` file in your project root. Use the `defineConfig` helper from `@langwatch/scenario-ts` to enable type safety and editor autocomplete:

```js
// scenario.config.js
const { defineConfig } = require("@langwatch/scenario-ts");

module.exports = defineConfig({
  defaultModel: "gpt-4-turbo",
});
```

Or with ESM:

```js
// scenario.config.mjs
import { defineConfig } from "@langwatch/scenario-ts";

export default defineConfig({
  defaultModel: "gpt-4-turbo",
});
```

This will be automatically loaded and used by the library. See the [API docs](./src/config/index.ts) for more details.

## License

MIT
