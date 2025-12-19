import { cn } from "@/lib/utils";

type ConnectionStatus = "disconnected" | "connecting" | "connected";

interface StatusIndicatorProps {
  status: ConnectionStatus;
  className?: string;
}

/**
 * StatusIndicator Component
 * Shows connection status with animated indicators
 */
export function StatusIndicator({ status, className }: StatusIndicatorProps) {
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

  const getStatusText = () => {
    switch (status) {
      case "connected":
        return "Connected - Start talking!";
      case "connecting":
        return "Connecting...";
      default:
        return "Disconnected";
    }
  };

  return (
    <div
      className={cn(
        "px-4 py-2 rounded-full backdrop-blur-md border text-sm font-semibold transition-all duration-300 flex items-center gap-2",
        getStatusColor(),
        className
      )}
    >
      <div
        className={cn(
          "w-2 h-2 rounded-full",
          status === "connected"
            ? "bg-emerald-400 animate-pulse"
            : status === "connecting"
            ? "bg-amber-400 animate-pulse"
            : "bg-red-400"
        )}
      />
      {getStatusText()}
    </div>
  );
}

