/**
 * Start the Ephemeral Token Server
 *
 * Run this script to start the backend server that generates
 * ephemeral tokens for browser clients.
 *
 * Usage:
 *   OPENAI_API_KEY=your-key-here tsx tests/realtime/server/start-server.ts
 */

import { createEphemeralTokenServer } from "./ephemeral-token-server.js";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("❌ Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

createEphemeralTokenServer({
  port: 3000,
  apiKey,
  corsOrigins: ["http://localhost:5173", "http://localhost:3000"],
}).catch((error) => {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
