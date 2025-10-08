import * as Tabs from "@radix-ui/react-tabs";
import { useMemo, type ReactNode } from "react";
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

  const tabs = useMemo(
    () =>
      childArray.map((child: React.ReactElement<CodeTabProps>) => ({
        title: child.props.title,
        content: child.props.children,
        language: child.props.language,
      })),
    [childArray]
  );

  // Use language as the active tab value directly
  const activeTabValue = useMemo(() => {
    const hasSelectedLanguage = tabs.some(
      (tab) => tab.language === selectedLanguage
    );
    return hasSelectedLanguage ? selectedLanguage : tabs[0]?.language;
  }, [tabs, selectedLanguage]);

  /**
   * Handle tab clicks - update global language store
   * Store change triggers re-render with new derived activeTabValue
   */
  const handleValueChange = (value: string) => {
    setLanguage(value as ProgrammingLanguage);
  };

  return (
    <Tabs.Root
      className="vocs_CodeGroup vocs_Tabs"
      value={activeTabValue}
      onValueChange={handleValueChange}
    >
      <Tabs.List className="vocs_Tabs_list">
        {tabs.map(({ title, language }) => (
          <Tabs.Trigger
            key={language}
            value={language}
            className="vocs_Tabs_trigger"
          >
            {title}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map(({ content, language }) => (
        <Tabs.Content
          key={language}
          value={language}
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
export const CodeTab = (props: CodeTabProps) => props.children;
