# Realtime Voice Agent

This example demonstrates how to create and test a **voice-enabled AI agent** using OpenAI's Realtime API, with **one source of truth** for the agent configuration.

## 🎯 What's Included

- **Agent Config** (`agents/vegetarian-recipe-agent.ts`) - **TypeScript single source of truth**
- **React Browser Client** (`realtime-client/`) - TypeScript, Vite, shadcn/ui components
- **Scenario Test** (planned) - Will use shared TypeScript config
- **Ephemeral Token Server** (`realtime-client/src/server/`) - Securely generate client tokens

## ✅ Key Principle: Same Agent, Accurate Testing

```typescript
// agents/vegetarian-recipe-agent.ts - ONE source of truth (TypeScript!)
export function createVegetarianRecipeAgent() { ... }

// realtime-client/src/App.tsx - Browser uses it (via Vite)
import { createVegetarianRecipeAgent } from '../../agents/vegetarian-recipe-agent';
const agent = createVegetarianRecipeAgent();

// test.ts - Tests use it (via Vitest)
import { createVegetarianRecipeAgent } from './realtime/agents/vegetarian-recipe-agent';
const agent = createVegetarianRecipeAgent();

// ✅ SAME TypeScript code = accurate testing!
```

## 🎨 Why Vite?

- ✅ TypeScript works natively (no build step during dev)
- ✅ Hot module replacement (instant updates)
- ✅ Proper module resolution
- ✅ Same imports in browser and tests
- ✅ Modern, fast, standard

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd javascript/examples/vitest
pnpm install
```

### 2. Set Your OpenAI API Key

Create a `.env` file:

```bash
echo "OPENAI_API_KEY=sk-proj-..." > .env
```

### 3. Start Everything (ONE COMMAND!)

```bash
pnpm realtime
```

This starts:
- 🔵 Token server on port 3000
- 🟣 Vite client on port 5173 (auto-opens browser)

Click "Connect" and start talking!

### 4. Run the Tests (Optional, separate terminal)

```bash
pnpm test vegetarian-recipe-realtime
```

Tests the **EXACT same TypeScript agent** that the browser uses!

## 🗣️ Try These Prompts

- "What's a quick pasta recipe?"
- "Give me ideas for a healthy lunch"
- "How do I make a vegetable stir-fry?"
- "I need a recipe using chickpeas"

## 🏗️ Architecture

```
                  ┌──────────────────────────────┐
                  │     Agent Config (TS!)       │  ← SINGLE SOURCE OF TRUTH
                  │  agents/vegetarian-recipe-   │
                  │         agent.ts             │
                  └──────┬──────────┬────────────┘
                         │          │
          ┌──────────────┘          └───────────────┐
          │                                          │
          ↓                                          ↓
┌─────────────────────┐                  ┌──────────────────┐
│  React Client       │                  │  Scenario Test   │
│  (Vite + TS)        │                  │  (Vitest + TS)   │
│  realtime-client/   │                  │  (planned)       │
└─────────┬───────────┘                  └────────┬─────────┘
          │                                       │
          │ WebRTC                                │ WebRTC
          │                                       │
          └──────────┬──────────┬─────────────────┘
                     │          │
                     ↓          ↓
          ┌──────────────────────────────┐
          │   Ephemeral Token Server     │
          │   (Express on :3000)         │
          └──────────────┬───────────────┘
                         │
                         │ Uses your API key
                         ↓
          ┌──────────────────────────────┐
          │      OpenAI Realtime API     │
          │   (voice processing server)  │
          └──────────────────────────────┘
```

**Key: TypeScript everywhere! Browser (via Vite) and tests (via Vitest) use IDENTICAL agent.**

## 📋 How It Works

### Ephemeral Tokens

The browser cannot directly use your OpenAI API key (security risk!). Instead:

1. **Browser** requests a token from **your server**
2. **Your server** calls OpenAI's `/realtime/client_secrets` endpoint
3. **OpenAI** returns an ephemeral token (starts with `ek_`)
4. **Browser** uses this token to connect via WebRTC
5. Token expires after a short time (typically 60 seconds)

### Voice Processing

The OpenAI Realtime API handles:

- **Voice Activity Detection** (VAD) - Knows when you start/stop speaking
- **Audio Processing** - Converts speech to text and back
- **Low Latency** - ~300ms round-trip via WebRTC
- **Natural Conversation** - Can be interrupted, supports back-and-forth

## 🔧 Customization

### Change the Agent Instructions

Edit **one file**: `agents/vegetarian-recipe-agent.ts`

```typescript
export const AGENT_INSTRUCTIONS = `
  YOUR NEW INSTRUCTIONS HERE
`;

// That's it! Browser and tests automatically use the new instructions.
```

### Add Tools/Functions

```typescript
// agents/vegetarian-recipe-agent.ts
export function createVegetarianRecipeAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
    tools: [{
      type: 'function',
      name: 'get_recipe',
      description: 'Fetch a recipe from database',
      parameters: {
        type: 'object',
        properties: {
          recipeName: { type: 'string' }
        }
      }
    }],
  });
}
```

## 📚 Next Steps

- **Testing** - Create Scenario tests (see test adapter implementation)
- **Deployment** - Deploy the token server to production
- **Production Client** - Integrate into your React/Next.js app

## 🔗 Resources

- [OpenAI Realtime API Docs](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/)
- [Scenario Testing Framework](https://github.com/langwatch/scenario)

## 🐛 Troubleshooting

### "Failed to fetch token"

- Ensure everything is running: `pnpm realtime` (starts both server and client)
- Check `OPENAI_API_KEY` is set in `.env`
- Token server should be on port 3000

### "Module not found" errors

- Run `pnpm install` in `javascript/examples/vitest`
- Ensure Vite dev server is running (part of `pnpm realtime`)
- Check you're navigating to http://localhost:5173 (Vite port)

### "Microphone access denied"

- Grant microphone permissions in your browser
- Try HTTPS (required by some browsers)

### "Connection failed"

- Check your network connection
- Ephemeral tokens expire quickly - reconnect if needed
- Check browser console for detailed errors

## 🎓 Learning Resources

See the inline documentation in:

- `realtime-client/src/server/ephemeral-token-server.ts` - Token generation
- `realtime-client/src/App.tsx` - React client implementation

