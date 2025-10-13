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
        style={{
          maxHeight: isExpanded ? "none" : `${defaultHeight}px`,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <CustomCodeGroup>{children}</CustomCodeGroup>
        {!isExpanded && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: "120px",
              background:
                "linear-gradient(to bottom, transparent, var(--vocs-color_background) 70%)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          marginTop: isExpanded ? "1rem" : "-0.5rem",
          padding: "0.5rem 1rem",
          background: "var(--vocs-color_background2)",
          border: "1px solid var(--vocs-color_border)",
          borderRadius: "0.375rem",
          cursor: "pointer",
          fontSize: "0.875rem",
          fontWeight: 500,
          color: "var(--vocs-color_text)",
          transition: "all 0.2s",
          position: "relative",
          zIndex: 10,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--vocs-color_background3)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--vocs-color_background2)";
        }}
      >
        {isExpanded ? "Show less ▲" : "Show more ▼"}
      </button>
    </div>
  );
}

