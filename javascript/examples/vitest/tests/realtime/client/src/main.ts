/**
 * Realtime Voice Agent - Browser Entry Point
 * 
 * Uses the SAME agent configuration as the Scenario tests.
 * TypeScript works seamlessly thanks to Vite!
 */

import { RealtimeSession } from "@openai/agents/realtime";
import { createVegetarianRecipeAgent, AGENT_CONFIG } from "../../shared/vegetarian-recipe-agent";

// DOM elements
const statusCard = document.getElementById("statusCard")!;
const statusText = document.getElementById("statusText")!;
const connectBtn = document.getElementById("connectBtn")!;
const disconnectBtn = document.getElementById("disconnectBtn")!;
const transcriptContainer = document.getElementById("transcriptContainer")!;
const micIndicator = document.getElementById("micIndicator")!;
const agentIndicator = document.getElementById("agentIndicator")!;
const errorMessage = document.getElementById("errorMessage")!;

let session: RealtimeSession | null = null;

// Create the Realtime Agent using shared configuration
// This is the SAME agent tested by Scenario framework
const agent = createVegetarianRecipeAgent();

/**
 * Updates the UI status display
 */
function setStatus(status: "disconnected" | "connecting" | "connected", text: string): void {
  statusCard.className = `status-card ${status}`;
  statusText.textContent = text;
}

/**
 * Shows an error message to the user
 */
function showError(message: string): void {
  errorMessage.textContent = message;
  errorMessage.classList.add("show");
  setTimeout(() => {
    errorMessage.classList.remove("show");
  }, 5000);
}

/**
 * Adds a message to the transcript display
 */
function addMessage(role: "user" | "agent", text: string): void {
  // Remove placeholder
  const placeholder = transcriptContainer.querySelector(".transcript-placeholder");
  if (placeholder) {
    placeholder.remove();
  }

  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}`;
  messageEl.innerHTML = `
    <div class="message-header">${role === "user" ? "You" : "Assistant"}</div>
    <div class="message-text">${text}</div>
  `;

  transcriptContainer.appendChild(messageEl);
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

/**
 * Connect button handler
 */
connectBtn.addEventListener("click", async () => {
  try {
    setStatus("connecting", "Connecting...");
    connectBtn.setAttribute("disabled", "true");

    // Fetch ephemeral token from our backend
    console.log("🔑 Fetching ephemeral token...");
    const tokenResponse = await fetch("http://localhost:3000/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to fetch token");
    }

    const { token } = await tokenResponse.json();
    console.log("✅ Token received");

    // Create session
    session = new RealtimeSession(agent, {
      model: AGENT_CONFIG.model,
    });

    // Listen for all events for debugging
    session.on("*", (event: any) => {
      console.log("🔔 Session event:", event.type);
    });

    // Listen for transcripts
    session.on("response:transcript:delta", (event: any) => {
      console.log("📝 Transcript delta:", event.delta);
    });

    session.on("response:transcript:done", (event: any) => {
      console.log("✅ Transcript done:", event.transcript);
      addMessage("agent", event.transcript);
    });

    session.on("input_audio_buffer.speech_started", () => {
      console.log("🎤 User started speaking");
      micIndicator.classList.add("active");
    });

    session.on("input_audio_buffer.speech_stopped", () => {
      console.log("🎤 User stopped speaking");
      micIndicator.classList.remove("active");
    });

    session.on("response.audio.delta", () => {
      agentIndicator.classList.add("active");
    });

    session.on("response.audio.done", () => {
      agentIndicator.classList.remove("active");
    });

    session.on("error", (error: any) => {
      console.error("❌ Session error:", error);
      showError(`Error: ${error.message || String(error)}`);
    });

    // Connect with ephemeral token
    console.log("🔌 Connecting to OpenAI Realtime API with token...");
    
    try {
      await session.connect({ apiKey: token });
      console.log("✅ Session.connect() completed");
    } catch (connectError) {
      console.error("❌ Connection error details:", connectError);
      throw connectError;
    }

    setStatus("connected", "Connected - Start talking!");
    disconnectBtn.removeAttribute("disabled");

    console.log("✅ Connected to Realtime API");
    addMessage(
      "agent",
      "Hi! I'm your vegetarian recipe assistant. What would you like to cook today?"
    );
  } catch (error) {
    console.error("❌ Connection failed:", error);
    setStatus("disconnected", "Connection failed");
    showError(error instanceof Error ? error.message : String(error));
    connectBtn.removeAttribute("disabled");
  }
});

/**
 * Disconnect button handler
 */
disconnectBtn.addEventListener("click", async () => {
  if (session) {
    await session.disconnect();
    session = null;
  }

  setStatus("disconnected", "Disconnected");
  connectBtn.removeAttribute("disabled");
  disconnectBtn.setAttribute("disabled", "true");
  micIndicator.classList.remove("active");
  agentIndicator.classList.remove("active");

  console.log("👋 Disconnected");
});

