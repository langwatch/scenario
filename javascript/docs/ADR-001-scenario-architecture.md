# ADR 001: Scenario Architecture for Testing AI Agents

## Status

Accepted

## Context

When testing AI agents, we need a way to evaluate their performance against specific success and failure criteria in various scenarios. These tests should be:

1. Repeatable and deterministic
2. Easy to configure and run
3. Able to simulate realistic user interactions
4. Capable of evaluating agent responses against clear criteria
5. Provide clear feedback about test results

## Decision

We've implemented a scenario-based testing architecture with the following key components:

1. **Scenario**: The main class that encapsulates test configuration and execution.

   - Contains description, strategy, success criteria, and failure criteria
   - Manages test execution and results

2. **TestableAgent**: Interface for agents that can be tested.

   - Requires an `invoke` method that accepts a message and returns a response

3. **ScenarioTestingAgent**: Simulates a user interacting with the agent under test.

   - Uses LLMs to generate realistic user messages
   - Evaluates agent responses against success/failure criteria
   - Makes verdict decisions based on configured criteria

4. **ConversationRunner**: Manages the conversation flow between agents.
   - Handles turn-taking logic
   - Enforces maximum turn limits
   - Collects conversation history

## Implementation Details

1. The `Scenario` class is initialized with a configuration object:

   ```typescript
   const scenario = new Scenario({
     description: "Test scenario description",
     strategy: "Test strategy to follow",
     successCriteria: ["Criterion 1", "Criterion 2"],
     failureCriteria: ["Failure condition 1"],
   });
   ```

2. The `run` method executes the test with the provided agent:

   ```typescript
   const result = await scenario.run({
     agent: myAgent,
     maxTurns: 5,
     verbose: true,
   });
   ```

3. The testing agent uses LLMs with a specific prompt structure to:

   - Generate realistic user messages
   - Evaluate responses against success/failure criteria
   - Make pass/fail decisions

4. Results include:
   - Final verdict (Success/Failure)
   - Detailed reasoning for the verdict
   - Conversation history
   - Criteria that were met or unmet

## Consequences

### Advantages

1. **Realistic Testing**: Using LLMs to simulate users provides more realistic test scenarios than static test inputs.
2. **Flexibility**: The framework can test various types of agents and scenarios.
3. **Clear Feedback**: Test results provide detailed information about why tests passed or failed.
4. **Extensibility**: The architecture can be extended to support different types of agents and evaluation methods.

### Challenges

1. **LLM Dependencies**: The system relies on LLMs for testing, which introduces external dependencies.
2. **Determinism**: LLM-based tests may not be fully deterministic, though using fixed prompts and temperatures helps.
3. **Complexity**: The system is more complex than simple unit tests but provides richer testing capabilities.

## Future Considerations

1. Support for more complex agent interactions (tools, multi-agent systems)
2. Enhanced reporting and visualization of test results
3. Integration with CI/CD pipelines
4. Support for more sophisticated evaluation criteria
