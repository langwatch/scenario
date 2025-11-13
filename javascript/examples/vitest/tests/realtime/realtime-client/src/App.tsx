import { useState, useRef, useCallback } from "react";
import { RealtimeSession } from "@openai/agents/realtime";
// import { createVegetarianRecipeSession } from "../../agents/vegetatrian-recipe.agent";
import { createDrewsAdvocateSession } from "../../agents/drews-advocate.agent";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { Orb, type AgentState } from "@/components/ui/orb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VoiceOrb } from "@/components/ui/VoiceOrb";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { MessageBubble } from "@/components/ui/MessageBubble";
import { X, Mic, MicOff, Radio } from "lucide-react";

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

      // Create session using shared session creator
      const session = createDrewsAdvocateSession();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.transport.on("*", (event: any) => {
        console.log("🔔 Session event:", event.type);
      });

      session.transport.on(
        "input_audio_buffer.speech_started",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
        (_event: any) => {
          console.log("🎤 User started speaking");
          setIsUserSpeaking(true);
        }
      );

      session.transport.on(
        "input_audio_buffer.speech_stopped",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
        (_event: any) => {
          console.log("🎤 User stopped speaking");
          setIsUserSpeaking(false);
        }
      );

      session.transport.on(
        "conversation.item.input_audio_transcription.completed",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (event: any) => {
          console.log("📝 User transcript:", event.transcript);
          if (event.transcript && event.transcript.trim()) {
            addMessage("user", event.transcript);
          }
        }
      );

      session.transport.on(
        "response.output_audio_transcript.delta",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (event: any) => {
          console.log("📝 Agent text delta:", event.delta);
        }
      );

      session.transport.on(
        "response.output_audio_transcript.done",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (event: any) => {
          console.log("✅ Agent text done:", event.transcript);
          if (event.transcript && event.transcript.trim()) {
            addMessage("agent", event.transcript);
          }
        }
      );

      session.transport.on(
        "output_audio_buffer.started",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
        (_event: any) => {
          console.log("🔊 Agent audio started");
          setIsAgentSpeaking(true);
        }
      );

      session.transport.on(
        "response.output_audio.done",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
        (_event: any) => {
          console.log("🔊 Agent audio done");
          setIsAgentSpeaking(false);
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.transport.on("error", (error: any) => {
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
    } catch (error) {
      console.error("❌ Connection failed:", error);
      setStatus("disconnected");
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDisconnect = async () => {
    if (sessionRef.current) {
      try {
        await sessionRef.current.close();
      } catch (error) {
        console.warn("Error closing session:", error);
      }
      sessionRef.current = null;
    }

    setStatus("disconnected");
    setIsUserSpeaking(false);
    setIsAgentSpeaking(false);
    setIsConversationStarted(false);
    setMessages([]); // Clear all messages
    setError(null); // Clear any errors
    console.log("👋 Disconnected");
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
              <VoiceOrb
                agentState={getAgentState()}
                onClick={handleOrbClick}
                disabled={status === "connecting"}
              />
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
              <StatusIndicator status={status} />

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
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isAgentSpeaking={isAgentSpeaking}
                    />
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
