# Agent Refactoring Summary

## Overview

Refactored agent architecture to use interface-first design with clean extension points via `invokeLLM()` hook.

## Key Changes

### 1. Added Core Interfaces

- `IAgent` - Base interface for all agents
- `IUserSimulatorAgent` - Interface for user simulators
- `IJudgeAgent` - Interface for judge agents
- All agents now accept `IAgent[]` instead of concrete classes

### 2. New `InvokeLLMInput` Type

```typescript
interface InvokeLLMInput {
  messages: CoreMessage[];
  model: any;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSet;
  toolChoice?: ToolChoice<any>;
}
```

### 3. Refactored Agent Classes

Both `UserSimulatorAgent` and `JudgeAgent` now:

- Implement interfaces (`IUserSimulatorAgent`, `IJudgeAgent`)
- Are regular classes (not abstract)
- Have `call()` method with ALL orchestration logic
- Have protected `invokeLLM()` hook for customization
- Have private helper methods (not overridable)

### 4. Deprecated Abstract Classes

- `AgentAdapter` → Use `IAgent` interface
- `UserSimulatorAgentAdapter` → Use `IUserSimulatorAgent` or extend `UserSimulatorAgent`
- `JudgeAgentAdapter` → Use `IJudgeAgent` or extend `JudgeAgent`
- Will be removed in v1.0

## Extension Pattern

### Simple Override

```typescript
class VoiceSimulator extends UserSimulatorAgent {
  private openai = new OpenAI();

  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      messages: input.messages,
      audio: { voice: "nova", format: "wav" },
      modalities: ["text", "audio"],
    });

    return {
      content: extractAudio(response),
      completion: response, // Access additional data if needed
    };
  }
}
```

### Duck Typing

```typescript
const myAgent: IAgent = {
  role: AgentRole.AGENT,
  async call(input) {
    return `Response`;
  },
};
```

## Benefits

1. **Single extension point** - Only override `invokeLLM()`
2. **Clean separation** - `call()` = orchestration, `invokeLLM()` = API call
3. **No duplication** - All logic in one place
4. **Type safety** - No `any` types, proper `LanguageModel` and `InvokeLLMResult`
5. **Extensible** - Return object provides raw completion for accessing additional data
6. **Works with any LLM** - Just return the right format
7. **Backwards compatible** - All existing code still works
8. **Duck typing** - Can use plain objects implementing `IAgent`

## Migration Guide

### Before (Old Pattern)

```typescript
class MyAgent extends AgentAdapter {
  async call(input: AgentInput) {
    // All logic here - hard to customize
    const response = await generateText({...});
    return response.text;
  }
}
```

### After (New Pattern)

```typescript
class MyAgent implements IAgent {
  role = AgentRole.AGENT;

  async call(input: AgentInput) {
    // Orchestration
    const llmInput: InvokeLLMInput = {
      messages: preparedMessages,
      model: "gpt-4",
    };
    return await this.invokeLLM(llmInput);
  }

  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    // Just the LLM call - easy to override
    const completion = await generateText(input);
    return {
      content: completion.text,
      completion, // Provide raw completion for extensibility
    };
  }
}
```

## Examples

See:

- `javascript/examples/vitest/tests/helpers/voice-user-simulator-simple.ts` - Simple voice override
- `javascript/examples/vitest/tests/simple-voice-override.test.ts` - Usage example

## Files Modified

- `javascript/src/agents/types.ts` - Added `InvokeLLMInput`
- `javascript/src/domain/agents/index.ts` - Added interfaces, deprecated adapters
- `javascript/src/domain/scenarios/index.ts` - Changed to `IAgent[]`
- `javascript/src/agents/user-simulator-agent.ts` - Refactored with `invokeLLM()` hook
- `javascript/src/agents/judge/judge-agent.ts` - Refactored with `invokeLLM()` hook
- `javascript/src/agents/index.ts` - Re-exported interfaces

## Breaking Changes

None in this release. Abstract classes deprecated but still functional.
Breaking changes will come in v1.0 when deprecated classes are removed.
