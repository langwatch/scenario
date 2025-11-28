import { cn } from "@/lib/utils";
import { Orb } from "@/components/ui/orb";
import { Mic } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "agent";
  parts: {
    type: "text";
    text: string;
  }[];
}

interface MessageBubbleProps {
  message: Message;
  isAgentSpeaking?: boolean;
  className?: string;
}

/**
 * MessageBubble Component
 * Individual message display with proper styling and animations
 */
export function MessageBubble({ message, isAgentSpeaking = false, className }: MessageBubbleProps) {
  return (
    <div
      className={cn(
        "flex gap-3 animate-in slide-in-from-bottom duration-500",
        message.role === "user" ? "justify-end" : "justify-start",
        className
      )}
    >
      {message.role === "agent" && (
        <div className="flex-shrink-0">
          <div className="bg-muted relative h-8 w-8 rounded-full p-0.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
            <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
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
  );
}

