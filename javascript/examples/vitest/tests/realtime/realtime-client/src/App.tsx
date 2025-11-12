import { useState, useEffect, useRef, useCallback } from "react";
import { RealtimeSession } from "@openai/agents/realtime";
import {
  createVegetarianRecipeAgent,
  AGENT_CONFIG,
} from "../../shared/vegetarian-recipe-agent";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { Orb, type AgentState } from "@/components/ui/orb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, Mic, MicOff, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "agent";
  parts: {
    type: "text";
    text: string;
  }[];
}

type ConnectionStatus = "disconnected" | "connecting" | "connected";

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isConversationStarted, setIsConversationStarted] = useState(false);
  const sessionRef = useRef<RealtimeSession | null>(null);

  const agent = createVegetarianRecipeAgent();

  const getAgentState = useCallback((): AgentState => {
    if (status === "connected" && isAgentSpeaking) return "talking";
    if (status === "connected" && isUserSpeaking) return "listening";
    if (status === "connected") return null;
    return null;
  }, [status, isUserSpeaking, isAgentSpeaking]);

  const addMessage = useCallback((role: "user" | "agent", text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role,
        parts: [{ type: "text", text }],
      },
    ]);
  }, []);

  const handleOrbClick = async () => {
    if (status !== "disconnected") return;

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
      setIsConversationStarted(true);

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
    setIsConversationStarted(false);
    console.log("👋 Disconnected");
  };

  const getStatusColor = () => {
    switch (status) {
      case "connected":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "connecting":
        return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      default:
        return "bg-red-500/20 text-red-400 border-red-500/30";
    }
  };

  if (!isConversationStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center p-4 relative overflow-hidden">
        {/* Animated background effects */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-pulse delay-1000" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-cyan-500/10 rounded-full blur-2xl animate-ping" />
        </div>

        <Card className="w-full max-w-2xl backdrop-blur-xl bg-white/10 border-white/20 shadow-2xl relative z-10">
          <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent rounded-xl" />

          <CardContent className="p-12 text-center space-y-8">
            {/* Interactive Orb */}
            <div className="flex justify-center">
              <button
                onClick={handleOrbClick}
                disabled={status === "connecting"}
                className={cn(
                  "group relative transition-all duration-500 hover:scale-105",
                  status === "connecting" && "animate-pulse"
                )}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-purple-400 to-blue-400 rounded-full blur-xl opacity-30 group-hover:opacity-50 transition-opacity" />
                <div className="relative bg-gradient-to-br from-white/20 to-white/5 rounded-full p-4 border border-white/30 backdrop-blur-sm shadow-2xl">
                  <div className="bg-muted relative h-24 w-24 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                    <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
                      <Orb
                        colors={["#CADCFC", "#A0B9D1"]}
                        seed={1000}
                        agentState={getAgentState()}
                      />
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {/* Title and Description */}
            <div className="space-y-4">
              <h1 className="text-4xl font-bold bg-gradient-to-r from-white to-white/80 bg-clip-text text-transparent">
                Vegetarian Recipe Agent
              </h1>
              <p className="text-white/70 text-lg max-w-md mx-auto">
                Click the orb to start your voice-powered cooking assistant. Get
                personalized recipe recommendations through natural
                conversation.
              </p>
            </div>

            {/* Status */}
            {status === "connecting" && (
              <div className="flex items-center justify-center gap-3">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span className="text-white/80">Connecting...</span>
              </div>
            )}

            {/* Features */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-2xl mb-2">🎙️</div>
                <div className="font-semibold text-white/90">Voice Powered</div>
                <div className="text-white/60">Natural speech recognition</div>
              </div>
              <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-2xl mb-2">🍳</div>
                <div className="font-semibold text-white/90">Recipe Expert</div>
                <div className="text-white/60">
                  Personalized recommendations
                </div>
              </div>
              <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-2xl mb-2">🌱</div>
                <div className="font-semibold text-white/90">
                  Vegetarian Focus
                </div>
                <div className="text-white/60">Plant-based cooking</div>
              </div>
            </div>

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
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Animated background effects */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      <Card className="w-full max-w-4xl h-[80vh] backdrop-blur-xl bg-white/10 border-white/20 shadow-2xl relative z-10 flex flex-col">
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent rounded-xl" />

        {/* Header */}
        <CardHeader className="relative z-10 flex-shrink-0 border-b border-white/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Mini Orb */}
              <div className="bg-muted relative h-10 w-10 rounded-full p-0.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
                  <Orb
                    colors={["#CADCFC", "#A0B9D1"]}
                    seed={1000}
                    agentState={getAgentState()}
                  />
                </div>
              </div>
              <div>
                <CardTitle className="text-xl text-white">
                  Vegetarian Recipe Agent
                </CardTitle>
                <p className="text-white/70 text-sm">
                  Voice-powered cooking assistant
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Status Badge */}
              <div
                className={`px-3 py-1 rounded-full backdrop-blur-md border text-sm font-semibold transition-all duration-300 ${getStatusColor()}`}
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
                    ? "Connected"
                    : status === "connecting"
                    ? "Connecting..."
                    : "Disconnected"}
                </div>
              </div>

              {/* Voice Indicators */}
              <div className="flex gap-4">
                <div className="flex items-center gap-2 text-white/70">
                  <div
                    className={`w-3 h-3 rounded-full transition-all duration-300 ${
                      isUserSpeaking
                        ? "bg-red-400 shadow-lg shadow-red-400/50 animate-pulse"
                        : "bg-white/20"
                    }`}
                  />
                  <div className="flex items-center gap-1 text-sm">
                    {isUserSpeaking ? (
                      <Mic className="w-4 h-4 text-red-400" />
                    ) : (
                      <MicOff className="w-4 h-4" />
                    )}
                    <span>You</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-white/70">
                  <div
                    className={`w-3 h-3 rounded-full transition-all duration-300 ${
                      isAgentSpeaking
                        ? "bg-purple-400 shadow-lg shadow-purple-400/50 animate-pulse"
                        : "bg-white/20"
                    }`}
                  />
                  <div className="flex items-center gap-1 text-sm">
                    <Radio className="w-4 h-4" />
                    <span>Agent</span>
                  </div>
                </div>
              </div>

              {/* Disconnect Button */}
              <Button
                onClick={handleDisconnect}
                variant="outline"
                size="sm"
                className="backdrop-blur-md bg-white/10 hover:bg-white/20 border-white/30 text-white"
              >
                <X className="w-4 h-4 mr-1" />
                End
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Conversation */}
        <CardContent className="relative z-10 flex-1 overflow-hidden p-0">
          <Conversation className="h-full">
            <ConversationContent className="h-full">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  icon={
                    <div className="bg-muted relative h-16 w-16 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                      <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
                        <Orb
                          colors={["#CADCFC", "#A0B9D1"]}
                          seed={1000}
                          agentState={null}
                        />
                      </div>
                    </div>
                  }
                  title="Start a conversation"
                  description="Speak naturally - your voice will be transcribed and responded to"
                  className="text-white/70 [&_h3]:text-white [&_p]:text-white/60"
                />
              ) : (
                <div className="space-y-6 p-6">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "flex gap-4 animate-in slide-in-from-bottom duration-500",
                        message.role === "user"
                          ? "justify-end"
                          : "justify-start"
                      )}
                    >
                      {message.role === "agent" && (
                        <div className="flex-shrink-0">
                          <div className="bg-muted relative h-8 w-8 rounded-full p-0.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
                            <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
                              <Orb
                                colors={["#CADCFC", "#A0B9D1"]}
                                seed={1000}
                                agentState={
                                  isAgentSpeaking && message.role === "agent"
                                    ? "talking"
                                    : null
                                }
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      <div
                        className={cn(
                          "max-w-[70%] rounded-2xl px-4 py-3 backdrop-blur-md border",
                          message.role === "user"
                            ? "bg-blue-500/20 border-blue-400/30 text-blue-100 rounded-br-sm"
                            : "bg-purple-500/20 border-purple-400/30 text-purple-100 rounded-bl-sm"
                        )}
                      >
                        <div className="text-sm leading-relaxed">
                          {message.parts[0]?.text}
                        </div>
                      </div>

                      {message.role === "user" && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
                          <Mic className="w-4 h-4 text-blue-300" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </CardContent>

        {/* Error Message */}
        {error && (
          <div className="absolute bottom-4 left-4 right-4 backdrop-blur-md bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-red-300 flex items-center justify-between animate-in slide-in-from-bottom">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-300 hover:text-red-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
