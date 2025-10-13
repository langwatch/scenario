import { useState, type ReactNode } from "react";
import { CustomCodeGroup } from "./CustomCodeGroup";

interface CollapsibleCodeGroupProps {
  children: ReactNode;
  defaultHeight?: number;
}

/**
 * CollapsibleCodeGroup component
 *
 * Wraps CustomCodeGroup to provide collapsible functionality for long code examples.
 * Shows a preview of the code with a "Show more" / "Show less" button.
 *
 * @param props - The props for the CollapsibleCodeGroup component
 * @param props.children - CodeTab components to render as tabs
 * @param props.defaultHeight - Maximum height in pixels before showing "Show more" button (default: 600)
 * @returns A collapsible tabbed interface for code examples
 */
export function CollapsibleCodeGroup({
  children,
  defaultHeight = 600,
}: CollapsibleCodeGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="relative">
      <div
        className="overflow-auto"
        style={{
          maxHeight: isExpanded ? "none" : `${defaultHeight}px`,
        }}
      >
        <CustomCodeGroup>{children}</CustomCodeGroup>
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
