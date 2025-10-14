import { useState, type ReactNode } from "react";

interface CollapsibleProps {
  children: ReactNode;
}

/**
 * Collapsible component
 *
 * Wraps any content to provide collapsible functionality.
 * Shows a preview of the content with an "Expand" / "Collapse" button.
 *
 * @param props - The props for the Collapsible component
 * @param props.children - Content to render
 * @returns A collapsible wrapper for content
 */
export function Collapsible({ children }: CollapsibleProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="relative">
      <div
        className="overflow-auto"
        style={{
          maxHeight: isExpanded ? "none" : "600px",
        }}
      >
        {children}
        {!isExpanded && (
          <div
            className="absolute bottom-0 left-0 right-0 h-[120px] pointer-events-none"
            style={{
              background:
                "linear-gradient(to bottom, transparent, var(--vocs-color_background) 70%)",
            }}
          />
        )}
      </div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`
          relative z-10 px-4 py-2 rounded-md cursor-pointer
          text-sm font-medium transition-all duration-200
          ${isExpanded ? "mt-4" : "-mt-2"}
          hover:bg-[var(--vocs-color_background3)]
        `}
        style={{
          background: "var(--vocs-color_background2)",
          border: "1px solid var(--vocs-color_border)",
          color: "var(--vocs-color_text)",
        }}
      >
        {isExpanded ? "Collapse ▲" : "Expand ▼"}
      </button>
    </div>
  );
}
