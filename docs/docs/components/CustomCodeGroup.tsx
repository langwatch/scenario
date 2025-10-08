import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { useLanguageStore } from "../stores/languageStore";
import type { ProgrammingLanguage } from "../stores/types";

interface CodeTabProps {
  title: string;
  children: ReactNode;
  language: ProgrammingLanguage;
}

/**
 * CustomCodeGroup component
 *
 * A tabbed code group component that renders multiple code examples in tabs.
 * Uses Radix UI tabs with Vocs styling classes for consistent appearance.
 * Automatically switches tabs based on global language selection from Zustand store.
 *
 * Note: If you are using imported mdx files, you must use the CustomCodeGroup
 * component.
 *
 * Otherwise, you can use the :::code-group::: directive.
 *
 * Usage:
 * ```typescript
 * <CustomCodeGroup>
 *   <CodeTab title="TypeScript" language="typescript">
 *     <SSETestExampleTS />
 *   </CodeTab>
 *   <CodeTab title="Python" language="python">
 *     <SSETestExamplePy />
 *   </CodeTab>
 * </CustomCodeGroup>
 * ```
 * @param props - The props for the CustomCodeGroup component
 * @param props.children - CodeTab components to render as tabs
 * @returns A tabbed interface for code examples
 */
export function CustomCodeGroup({ children }: { children: ReactNode }) {
  const { language: selectedLanguage, setLanguage } = useLanguageStore();
  const childArray = Array.isArray(children) ? children : [children];

  const tabs = childArray.map((child: React.ReactElement<CodeTabProps>) => ({
    title: child.props.title,
    content: child.props.children,
    language: child.props.language,
  }));

  // Derive active tab directly from store language - no local state needed
  const activeTab = tabs.find((tab) => tab.language === selectedLanguage);
  const activeTabValue = activeTab?.title ?? tabs[0]?.title;

  /**
   * Handle tab clicks - update global language store
   * Store change triggers re-render with new derived activeTabValue
   */
  const handleValueChange = (value: string) => {
    const clickedTab = tabs.find((tab) => tab.title === value);
    if (clickedTab) {
      setLanguage(clickedTab.language);
    }
  };

  return (
    <Tabs.Root
      className="vocs_CodeGroup vocs_Tabs"
      value={activeTabValue}
      onValueChange={handleValueChange}
    >
      <Tabs.List className="vocs_Tabs_list">
        {tabs.map(({ title, language }, i) => (
          <Tabs.Trigger
            key={title || String(i)}
            value={title || String(i)}
            className="vocs_Tabs_trigger"
            data-language={language}
          >
            {title}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map(({ title, content, language }, i) => (
        <Tabs.Content
          key={title || String(i)}
          value={title || String(i)}
          className="vocs_Tabs_content"
          data-language={language}
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
export const CodeTab = (props: CodeTabProps) => props.children;
