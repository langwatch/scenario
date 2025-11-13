import { Orb, type AgentState } from "@/components/ui/orb";
import { cn } from "@/lib/utils";

interface VoiceOrbProps {
  agentState: AgentState;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * VoiceOrb Component
 * Interactive orb that starts voice conversations
 */
export function VoiceOrb({ agentState, onClick, disabled = false, className }: VoiceOrbProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group relative transition-all duration-500 hover:scale-105",
        disabled && "animate-pulse",
        className
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-purple-400 to-blue-400 rounded-full blur-xl opacity-30 group-hover:opacity-50 transition-opacity" />
      <div className="relative bg-gradient-to-br from-white/20 to-white/5 rounded-full p-4 border border-white/30 backdrop-blur-sm shadow-2xl">
        <div className="bg-muted relative h-24 w-24 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)]">
          <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
            <Orb
              colors={["#CADCFC", "#A0B9D1"]}
              seed={1000}
              agentState={agentState}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

