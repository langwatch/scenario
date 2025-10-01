import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

/**
 * CustomCodeGroup component
 *
 * A tabbed code group component that renders multiple code examples in tabs.
 * Uses Radix UI tabs with Vocs styling classes for consistent appearance.
 *
 * @param props - The props for the CustomCodeGroup component
 * @param props.children - CodeTab components to render as tabs
 * @returns A tabbed interface for code examples
 */
export function CustomCodeGroup({ children }: { children: ReactNode }) {
  const childArray = Array.isArray(children) ? children : [children];

  const tabs = childArray.map((child: any) => ({
    title: child.props.title,
    content: child.props.children,
  }));

  return (
    <Tabs.Root
      className="vocs_CodeGroup vocs_Tabs"
      defaultValue={tabs[0]?.title}
    >
      <Tabs.List className="vocs_Tabs_list">
        {tabs.map(({ title }, i) => (
          <Tabs.Trigger
            key={title || i}
            value={title || i}
            className="vocs_Tabs_trigger"
          >
            {title}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map(({ title, content }, i) => (
        <Tabs.Content
          key={title || i}
          value={title || i}
          className="vocs_Tabs_content"
        >
          {content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

/**
 * CodeTab component
 *
 * This component is used to define the signature of the code tab
 * to makes sure we have a consistent interface for the code tabs.
 *
 * @param props - The props for the CodeTab component
 * @param props.title - The title of the code tab
 * @param props.children - The children of the code tab
 * @returns The children of the code tab
 */
export const CodeTab = (props: { title: string; children: ReactNode }) =>
  props.children;
