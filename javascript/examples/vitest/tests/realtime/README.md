# Realtime Voice Agent

This example demonstrates how to create and test a **voice-enabled AI agent** using OpenAI's Realtime API, with **one source of truth** for the agent configuration.

## 🎯 What's Included

- **Agent Config** (`agents/vegetarian-recipe-agent.ts`) - **TypeScript single source of truth**
- **React Browser Client** (`realtime-client/`) - TypeScript, Vite, shadcn/ui components
- **Scenario Test** (planned) - Will use shared TypeScript config
- **Ephemeral Token Server** (`realtime-client/src/server/`) - Securely generate client tokens

## ✅ Key Principle: Same Agent, Accurate Testing

```typescript
// shared/vegetarian-recipe-agent.ts - ONE source of truth (TypeScript!)
export function createVegetarianRecipeAgent() { ... }

// client/src/main.ts - Browser uses it (via Vite)
import { createVegetarianRecipeAgent } from '../../shared/vegetarian-recipe-agent';
const agent = createVegetarianRecipeAgent();

// vegetarian-recipe-realtime.test.ts - Tests use it (via Vitest)
import { createVegetarianRecipeAgent } from './realtime/shared/vegetarian-recipe-agent';
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
                  │  Shared Agent Config (TS!)   │  ← SINGLE SOURCE OF TRUTH
                  │  vegetarian-recipe-agent.ts  │
                  └──────┬──────────┬────────────┘
                         │          │
          ┌──────────────┘          └───────────────┐
          │                                          │
          ↓                                          ↓
┌─────────────────────┐                  ┌──────────────────┐
│  Browser Client     │                  │  Scenario Test   │
│  (Vite + TS)        │                  │  (Vitest + TS)   │
│  main.ts            │                  │  .test.ts        │
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

Edit **one file**: `shared/vegetarian-recipe-agent.ts`

```typescript
export const AGENT_INSTRUCTIONS = `
  YOUR NEW INSTRUCTIONS HERE
`;

// That's it! Browser and tests automatically use the new instructions.
```

### Add Tools/Functions

```typescript
// shared/vegetarian-recipe-agent.ts
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

- Ensure token server is running: `pnpm realtime-server`
- Check `OPENAI_API_KEY` is set
- Token server should be on port 3000

### "Module not found" errors

- Ensure Vite dev server is running: `pnpm realtime-client`
- Check you're navigating to http://localhost:5173 (Vite port)
- Not http://localhost:3000 (token server port)

### "Microphone access denied"

- Grant microphone permissions in your browser
- Try HTTPS (required by some browsers)

### "Connection failed"

- Check your network connection
- Ephemeral tokens expire quickly - reconnect if needed
- Check browser console for detailed errors

## 🎓 Learning Resources

See the inline documentation in:

- `server/ephemeral-token-server.ts` - Token generation
- `client/demo.html` - Browser client implementation

