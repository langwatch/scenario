# Architecture: Same Agent Testing

## 🎯 Core Principle

**The agent tested by Scenario is EXACTLY the agent used by the browser.**

This is achieved through a **shared configuration module** that both browser and tests import.

---

## 📁 File Structure

```
tests/realtime/
├── shared/
│   └── vegetarian-recipe-agent.ts    # ← SINGLE SOURCE OF TRUTH
│       - Agent instructions
│       - Voice settings
│       - Model configuration
│       - createVegetarianRecipeAgent()
│
├── client/
│   └── demo.html                      # Browser client
│       import { createVegetarianRecipeAgent } from '../shared/...'
│
├── helpers/
│   ├── realtime-agent-adapter.ts      # Scenario adapter
│   └── index.ts
│
├── server/
│   ├── ephemeral-token-server.ts      # Token generation
│   └── start-server.ts
│
└── vegetarian-recipe-realtime.test.ts # Tests
    import { createVegetarianRecipeAgent } from './realtime/shared/...'
```

---

## 🔄 How It Works

### 1. Define Agent Once

```typescript
// shared/vegetarian-recipe-agent.ts
export const AGENT_INSTRUCTIONS = `You are a friendly vegetarian recipe assistant...`;

export const AGENT_CONFIG = {
  name: "Vegetarian Recipe Assistant",
  instructions: AGENT_INSTRUCTIONS,
  voice: "alloy",
  model: "gpt-4o-realtime-preview-2024-12-17",
};

export function createVegetarianRecipeAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}
```

### 2. Browser Uses It

```typescript
// client/demo.html
import { createVegetarianRecipeAgent, AGENT_CONFIG } from '../shared/vegetarian-recipe-agent.js';

const agent = createVegetarianRecipeAgent();
const session = new RealtimeSession(agent, {
  model: AGENT_CONFIG.model
});
```

### 3. Tests Use It

```typescript
// vegetarian-recipe-realtime.test.ts
import { createVegetarianRecipeAgent } from './realtime/shared/vegetarian-recipe-agent.js';

const agent = createVegetarianRecipeAgent();
const adapter = new RealtimeAgentAdapter({ agent });

await scenario.run({
  agents: [adapter, scenario.userSimulatorAgent()],
  // ...
});
```

---

## ✅ Benefits

### 1. Accurate Testing
- Tests validate the **actual production agent**
- No test doubles or mocks
- Catch real issues before deployment

### 2. Single Source of Truth
- Change agent once, updates everywhere
- No drift between test and production
- Easier maintenance

### 3. Confidence
- If tests pass, browser works
- No "works in tests but fails in production"
- True integration testing

---

## 🔌 Connection Flow

### Browser Flow

```
1. User clicks "Connect"
   ↓
2. Fetch ephemeral token from server
   POST http://localhost:3000/token
   ↓
3. Create agent (shared config)
   const agent = createVegetarianRecipeAgent()
   ↓
4. Create RealtimeSession
   const session = new RealtimeSession(agent)
   ↓
5. Connect with token
   await session.connect({ apiKey: token })
   ↓
6. User speaks → microphone → WebRTC → OpenAI → audio response
```

### Test Flow

```
1. beforeAll: Connect adapter
   ↓
2. Fetch ephemeral token from server
   POST http://localhost:3000/token
   ↓
3. Create agent (SAME shared config!)
   const agent = createVegetarianRecipeAgent()
   ↓
4. Wrap in RealtimeAgentAdapter
   const adapter = new RealtimeAgentAdapter({ agent })
   ↓
5. Connect adapter
   await adapter.connect()
   ↓
6. Run scenario
   - User simulator sends text
   - Adapter forwards to session
   - Gets transcript back
   - Returns to Scenario framework
   ↓
7. afterAll: Disconnect
   await adapter.disconnect()
```

---

## 🧪 Testing Strategy

### Text Input (Fast, CI-Friendly)

```typescript
await scenario.run({
  agents: [
    realtimeAdapter,              // Real Realtime agent
    scenario.userSimulatorAgent(), // Text user simulator
    scenario.judgeAgent(),         // Evaluates transcripts
  ],
  script: [
    scenario.user("quick recipe"),  // Text → Realtime API
    scenario.agent(),               // Audio response → transcript
    scenario.judge(),
  ],
});
```

**Pros**: Fast, no audio processing overhead  
**Tests**: Agent logic, instructions, conversation flow

### Audio Input (Realistic, Comprehensive)

```typescript
// Future enhancement: AudioUserSimulatorAgent
// Uses gpt-4o-audio-preview to generate native audio
await scenario.run({
  agents: [
    realtimeAdapter,
    audioUserSimulator,    // Generates audio
    audioJudgeAgent,       // Transcribes for judgment
  ],
  // ...
});
```

**Pros**: Tests full voice pipeline  
**Tests**: Audio quality, prosody, interruptions

---

## 🎨 Customization

Want to change the agent? Update ONE file:

```typescript
// shared/vegetarian-recipe-agent.ts

export const AGENT_INSTRUCTIONS = `
  NEW INSTRUCTIONS HERE
`;

// That's it! Browser and tests automatically use new instructions.
```

---

## 🔒 Security

**Ephemeral Tokens** prevent API key exposure:

1. **Browser** cannot see your OpenAI API key
2. **Server** generates short-lived tokens (`ek_...`)
3. **Token** expires in ~60 seconds
4. **OpenAI** validates token, not API key

Same pattern for both browser and tests!

---

## 📊 Comparison to Other Approaches

### ❌ Bad: Separate Agent Definitions

```typescript
// client.ts
const agent = new RealtimeAgent({
  instructions: "Help with recipes...",
});

// test.ts  
const mockAgent = new MockAgent({
  instructions: "Help with recipes...",  // Might drift!
});
```

**Problem**: Test and production can drift apart.

### ❌ Bad: Mock Agent

```typescript
// test.ts
const mockAgent = {
  call: async () => "Mocked recipe response"
};
```

**Problem**: Tests don't validate real agent behavior.

### ✅ Good: Shared Configuration (This Approach)

```typescript
// shared/agent.ts
export function createAgent() { ... }

// client.ts
const agent = createAgent();

// test.ts
const agent = createAgent();  // SAME!
```

**Solution**: One source of truth, accurate testing.

---

## 🚀 Deployment

### Development
```bash
# Terminal 1: Start token server
pnpm realtime-server

# Terminal 2: Run tests
pnpm test vegetarian-recipe-realtime

# Terminal 3: Open browser
open http://localhost:3000/demo.html
```

### Production

1. **Deploy token server** (Vercel/Railway/AWS)
2. **Tests keep working** (point to production server)
3. **Agent stays identical** (shared config)

```typescript
// Just change the URL
const adapter = new RealtimeAgentAdapter({
  agent: createVegetarianRecipeAgent(),
  tokenServerUrl: "https://your-server.com",  // Production!
});
```

---

## 📚 Further Reading

- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
- [Scenario Testing Framework](https://github.com/langwatch/scenario)

