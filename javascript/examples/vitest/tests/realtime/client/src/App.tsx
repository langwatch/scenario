import { useState, useEffect, useRef } from "react";
import { RealtimeSession } from "@openai/agents/realtime";
import {
  createVegetarianRecipeAgent,
  AGENT_CONFIG,
} from "../../shared/vegetarian-recipe-agent";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Orb, type AgentState } from "@/components/ui/orb";
import { Radio, X, Mic, MicOff } from "lucide-react";

interface Message {
  role: "user" | "agent";
  text: string;
  id: string;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected";

export function App() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = createVegetarianRecipeAgent();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = (role: "user" | "agent", text: string) => {
    setMessages((prev) => [
      ...prev,
      { role, text, id: `${Date.now()}-${Math.random()}` },
    ]);
  };

  const getAgentState = (): AgentState => {
    if (status === "connected" && isAgentSpeaking) return "talking";
    if (status === "connected" && isUserSpeaking) return "listening";
    if (status === "connected") return null;
    return null;
  };

  const handleConnect = async () => {
    try {
      setStatus("connecting");
      setError(null);

      console.log("🔑 Fetching ephemeral token...");
      const tokenResponse = await fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!tokenResponse.ok) {
        throw new Error("Failed to fetch token");
      }

      const { token } = await tokenResponse.json();
      console.log("✅ Token received");

      const session = new RealtimeSession(agent, {
        model: AGENT_CONFIG.model,
      });

      session.on("*", (event: any) => {
        console.log("🔔 Session event:", event.type);
      });

      session.on("response:transcript:delta", (event: any) => {
        console.log("📝 Transcript delta:", event.delta);
      });

      session.on("response:transcript:done", (event: any) => {
        console.log("✅ Transcript done:", event.transcript);
        addMessage("agent", event.transcript);
      });

      session.on("input_audio_buffer.speech_started", () => {
        console.log("🎤 User started speaking");
        setIsUserSpeaking(true);
      });

      session.on("input_audio_buffer.speech_stopped", () => {
        console.log("🎤 User stopped speaking");
        setIsUserSpeaking(false);
      });

      session.on("response.audio.delta", () => {
        setIsAgentSpeaking(true);
      });

      session.on("response.audio.done", () => {
        setIsAgentSpeaking(false);
      });

      session.on("error", (error: any) => {
        console.error("❌ Session error:", error);
        setError(`Error: ${error.message || String(error)}`);
      });

      console.log("🔌 Connecting to OpenAI Realtime API with token...");

      try {
        await session.connect({ apiKey: token });
        console.log("✅ Session.connect() completed");
      } catch (connectError) {
        console.error("❌ Connection error details:", connectError);
        throw connectError;
      }

      sessionRef.current = session;
      setStatus("connected");

      console.log("✅ Connected to Realtime API");
      addMessage(
        "agent",
        "Hi! I'm your vegetarian recipe assistant. What would you like to cook today?"
      );
    } catch (error) {
      console.error("❌ Connection failed:", error);
      setStatus("disconnected");
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDisconnect = async () => {
    if (sessionRef.current) {
      await sessionRef.current.disconnect();
      sessionRef.current = null;
    }

    setStatus("disconnected");
    setIsUserSpeaking(false);
    setIsAgentSpeaking(false);
    console.log("👋 Disconnected");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Animated background effects */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      <Card className="w-full max-w-3xl backdrop-blur-xl bg-white/10 border-white/20 shadow-2xl relative z-10">
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent rounded-lg" />
        
        <CardHeader className="relative z-10 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Orb Avatar */}
              <div className="relative">
                <div className="bg-muted relative h-20 w-20 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)]">
                  <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]">
                    <Orb
                      colors={["#CADCFC", "#A0B9D1"]}
                      seed={1000}
                      agentState={getAgentState()}
                    />
                  </div>
                </div>
                {status === "connected" && (
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 rounded-full border-2 border-background animate-pulse" />
                )}
              </div>
              <div>
                <CardTitle className="text-2xl font-bold text-white">
                  Vegetarian Recipe Agent
                </CardTitle>
                <p className="text-sm text-white/70 mt-1">
                  Talk to your AI cooking assistant using voice
                </p>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="relative z-10 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="backdrop-blur-md bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-red-300 flex items-center justify-between animate-in slide-in-from-top">
              <span>{error}</span>
              <button
                onClick={() => setError(null)}
                className="text-red-300 hover:text-red-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Status Badge */}
          <div className="flex items-center justify-center gap-3">
            <div
              className={`px-4 py-2 rounded-full backdrop-blur-md border text-sm font-semibold transition-all duration-300 ${
                status === "connected"
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : status === "connecting"
                  ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                  : "bg-red-500/20 text-red-400 border-red-500/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    status === "connected"
                      ? "bg-emerald-400 animate-pulse"
                      : status === "connecting"
                      ? "bg-amber-400 animate-pulse"
                      : "bg-red-400"
                  }`}
                />
                {status === "connected"
                  ? "Connected - Start talking!"
                  : status === "connecting"
                  ? "Connecting..."
                  : "Disconnected"}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex gap-3">
            <Button
              onClick={handleConnect}
              disabled={status !== "disconnected"}
              className="flex-1 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 text-white border-0 shadow-lg hover:shadow-xl transition-all duration-300 disabled:opacity-50"
            >
              <Radio className="w-4 h-4 mr-2" />
              Connect
            </Button>
            <Button
              onClick={handleDisconnect}
              disabled={status !== "connected"}
              variant="destructive"
              className="flex-1 backdrop-blur-md bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 shadow-lg hover:shadow-xl transition-all duration-300 disabled:opacity-50"
            >
              <X className="w-4 h-4 mr-2" />
              Disconnect
            </Button>
          </div>

          {/* Conversation Container */}
          <div className="backdrop-blur-md bg-black/20 border border-white/10 rounded-lg p-6 min-h-[400px] max-h-[500px] overflow-y-auto relative">
            {messages.length === 0 ? (
              <div className="text-center text-white/60 py-16 space-y-4">
                <div className="flex justify-center">
                  <div className="bg-muted relative h-24 w-24 rounded-full p-2 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                    <div className="bg-background h-full w-full overflow-hidden rounded-full">
                      <Orb
                        colors={["#CADCFC", "#A0B9D1"]}
                        seed={1000}
                        agentState={null}
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-lg font-semibold text-white/80 mb-2">
                    Start a conversation
                  </p>
                  <p className="text-sm mb-4">
                    Click "Connect" to start talking with your vegetarian recipe assistant.
                  </p>
                  <div className="text-xs space-y-1 text-white/60">
                    <p className="font-semibold text-white/70">Try asking:</p>
                    <p>"What's a quick pasta recipe?"</p>
                    <p>"Give me ideas for a healthy lunch"</p>
                    <p>"How do I make a vegetable stir-fry?"</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex gap-3 ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    } animate-in slide-in-from-bottom`}
                  >
                    {message.role === "assistant" && (
                      <div className="flex-shrink-0">
                        <div className="bg-muted relative h-8 w-8 rounded-full p-0.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                          <div className="bg-background h-full w-full overflow-hidden rounded-full">
                            <Orb
                              colors={["#CADCFC", "#A0B9D1"]}
                              seed={1000}
                              agentState={isAgentSpeaking ? "talking" : null}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    <div
                      className={`max-w-[75%] rounded-2xl p-4 backdrop-blur-md ${
                        message.role === "user"
                          ? "bg-blue-500/20 border border-blue-400/30 text-blue-100 rounded-br-sm"
                          : "bg-purple-500/20 border border-purple-400/30 text-purple-100 rounded-bl-sm"
                      }`}
                    >
                      <div className="text-sm leading-relaxed">{message.text}</div>
                    </div>
                    {message.role === "user" && (
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
                        <Mic className="w-4 h-4 text-blue-300" />
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Voice Indicators */}
          <div className="flex gap-6 justify-center">
            <div className="flex items-center gap-2 text-white/70">
              <div
                className={`w-3 h-3 rounded-full transition-all duration-300 ${
                  isUserSpeaking
                    ? "bg-red-400 shadow-lg shadow-red-400/50 animate-pulse"
                    : "bg-white/20"
                }`}
              />
              <span className="text-sm flex items-center gap-1.5">
                {isUserSpeaking ? (
                  <Mic className="w-4 h-4 text-red-400" />
                ) : (
                  <MicOff className="w-4 h-4" />
                )}
                Your Voice
              </span>
            </div>
            <div className="flex items-center gap-2 text-white/70">
              <div
                className={`w-3 h-3 rounded-full transition-all duration-300 ${
                  isAgentSpeaking
                    ? "bg-purple-400 shadow-lg shadow-purple-400/50 animate-pulse"
                    : "bg-white/20"
                }`}
              />
              <span className="text-sm flex items-center gap-1.5">
                <Radio className="w-4 h-4" />
                Agent Speaking
              </span>
            </div>
          </div>

          {/* Footer */}
          <div className="text-center text-white/40 text-xs">
            Powered by OpenAI Realtime API
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
