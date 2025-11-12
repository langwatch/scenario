/**
 * Ephemeral Token Server
 *
 * Generates short-lived client tokens for browser connections to OpenAI Realtime API.
 * This server should run on your backend to keep your OpenAI API key secure.
 *
 * The ephemeral token (starts with "ek_") allows browsers to connect directly
 * to OpenAI's Realtime API via WebRTC without exposing your API key.
 */

import express from "express";
import { OpenAI } from "openai";

/**
 * Configuration for the ephemeral token server
 */
export interface EphemeralTokenServerConfig {
  /**
   * Port to run the server on
   */
  port: number;

  /**
   * OpenAI API key for generating ephemeral tokens
   */
  apiKey: string;

  /**
   * CORS origins to allow (for browser connections)
   * @default ["http://localhost:3000"]
   */
  corsOrigins?: string[];

  /**
   * Model to use for Realtime API
   * @default "gpt-4o-realtime-preview-2024-12-17"
   */
  model?: string;
}

/**
 * Creates and starts an ephemeral token server
 *
 * This server exposes:
 * - POST /token - Generates ephemeral tokens for clients
 * - GET /health - Health check endpoint
 * - Static files from ./client directory
 *
 * @param config - Server configuration
 * @returns Express application instance
 *
 * @example
 * ```typescript
 * const server = await createEphemeralTokenServer({
 *   port: 3000,
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   corsOrigins: ["http://localhost:5173"],
 * });
 * ```
 */
export async function createEphemeralTokenServer(
  config: EphemeralTokenServerConfig
): Promise<express.Application> {
  const app = express();
  const openai = new OpenAI({ apiKey: config.apiKey });

  const corsOrigins = config.corsOrigins ?? ["http://localhost:3000"];
  const model = config.model ?? "gpt-4o-realtime-preview-2024-12-17";

  // Middleware
  app.use(express.json());

  // CORS middleware
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }

    next();
  });

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", model });
  });

  /**
   * POST /token
   *
   * Generates an ephemeral client token for browser connections.
   *
   * Response:
   * ```json
   * {
   *   "token": "ek_...",
   *   "expiresAt": "2024-01-01T00:00:00.000Z"
   * }
   * ```
   */
  app.post("/token", async (req, res) => {
    try {
      console.log("📝 Generating ephemeral token...");

      // Call OpenAI API to create ephemeral token
      // Using fetch since OpenAI SDK's post method might not work for this endpoint
      const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: model,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Log the full response to debug structure
      console.log("📦 Raw OpenAI response:", JSON.stringify(data, null, 2));

      // The token might be at the top level or nested
      const token = data.value || data.client_secret?.value || data.token;
      const expiresAt = data.expires_at || data.client_secret?.expires_at;

      if (!token) {
        throw new Error(`No token in response. Response structure: ${JSON.stringify(data)}`);
      }

      console.log("✅ Token generated:", {
        token: token.substring(0, 20) + "...",
        expiresAt: expiresAt,
      });

      res.json({
        token: token,
        expiresAt: expiresAt,
      });
    } catch (error) {
      console.error("❌ Failed to generate token:", error);

      res.status(500).json({
        error: "Failed to generate token",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Serve static files from realtime directory (includes client/ and shared/)
  app.use(express.static("tests/realtime"));

  // Start server
  return new Promise((resolve) => {
    app.listen(config.port, () => {
      console.log(`
🚀 Ephemeral Token Server running
   
   URL: http://localhost:${config.port}
   POST /token - Generate ephemeral tokens
   GET /health - Health check
   
   Next: Start Vite client with "pnpm realtime-client"
   Then open: http://localhost:5173
      `);
      resolve(app);
    });
  });
}

/**
 * Stops the server
 *
 * @param app - Express application to stop
 */
export async function stopServer(app: express.Application): Promise<void> {
  const server = (app as any).server;
  if (server) {
    return new Promise((resolve) => {
      server.close(() => {
        console.log("🛑 Server stopped");
        resolve();
      });
    });
  }
}
