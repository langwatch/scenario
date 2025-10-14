import * as Tabs from "@radix-ui/react-tabs";
import React, { useMemo, type ReactNode } from "react";
import { useLanguageStore } from "../stores/languageStore";
import type { ProgrammingLanguage } from "../stores/types";
import { LANGUAGE_TITLE_MAP } from "../constants";
import { Collapsible } from "./Collapsible";

interface BaseTabProps {
  title?: string;
  children: ReactNode;
  language: ProgrammingLanguage;
}

type CodeTabProps = BaseTabProps;

type MarkdownTabProps = BaseTabProps;

/**
 * LanguageTabs component
 *
 * A tabbed component that renders language-specific content in tabs.
 * Uses Radix UI tabs with Vocs styling classes for consistent appearance.
 * Automatically switches tabs based on global language selection from Zustand store.
 *
 * Supports two types of tabs:
 * - CodeTab: For code examples (uses code group styling)
 * - MarkdownTab: For markdown content (uses standard tab styling)
 *
 * Usage:
 * ```typescript
 * <LanguageTabs collapsible>
 *   <LanguageTabs.CodeTab language="typescript">
 *     <ImportedCodeExample />
 *   </LanguageTabs.CodeTab>
 *   <LanguageTabs.MarkdownTab language="python">
 *     <div>Setup instructions...</div>
 *   </LanguageTabs.MarkdownTab>
 * </LanguageTabs>
 * ```
 * @param props - The props for the LanguageTabs component
 * @param props.children - Tab components to render
 * @param props.collapsible - Whether to wrap in collapsible wrapper
 * @returns A tabbed interface for language-specific content
 */
export function LanguageTabs({
  children,
  collapsible,
}: {
  children: ReactNode;
  collapsible?: boolean;
}) {
  const { language: selectedLanguage, setLanguage } = useLanguageStore();
  const childArray = Array.isArray(children) ? children : [children];

  const tabs = useMemo(
    () =>
      childArray.map((child: React.ReactElement<BaseTabProps>) => ({
        title: child.props.title ?? LANGUAGE_TITLE_MAP[child.props.language],
        language: child.props.language,
      })),
    [childArray]
  );

  const activeTabValue = useMemo(() => {
    const hasSelectedLanguage = tabs.some(
      (tab) => tab.language === selectedLanguage
    );
    return hasSelectedLanguage ? selectedLanguage : tabs[0]?.language;
  }, [tabs, selectedLanguage]);

  // Use code group styling only if all children are CodeTab components
  const isCodeGroup = childArray.every(
    (child: React.ReactElement) =>
      (child.type as { displayName?: string })?.displayName ===
      "LanguageTabs.CodeTab"
  );

  const handleValueChange = (value: string) => {
    setLanguage(value as ProgrammingLanguage);
  };

  const tabsContent = (
    <Tabs.Root
      className={isCodeGroup ? "vocs_CodeGroup vocs_Tabs" : "vocs_Tabs"}
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
      {children}
    </Tabs.Root>
  );

  if (collapsible) {
    return <Collapsible>{tabsContent}</Collapsible>;
  }

  return tabsContent;
}

const CodeTabComponent = ({ language, children }: CodeTabProps) => (
  <Tabs.Content value={language}>{children}</Tabs.Content>
);
CodeTabComponent.displayName = "LanguageTabs.CodeTab";
LanguageTabs.CodeTab = CodeTabComponent;

const MarkdownTabComponent = ({ language, children }: MarkdownTabProps) => (
  <Tabs.Content value={language} className="p-5">
    {children}
  </Tabs.Content>
);
MarkdownTabComponent.displayName = "LanguageTabs.MarkdownTab";
LanguageTabs.MarkdownTab = MarkdownTabComponent;
