import { type ReactElement } from "react";
import { useLanguageStore } from "../stores/languageStore";
import type { ProgrammingLanguage } from "../stores/types";

/**
 * Language selector dropdown component
 *
 * Provides a UI control for switching between Python and TypeScript code examples.
 * State is managed globally via Zustand and persisted to localStorage.
 * Changes are automatically synchronized across all components and browser tabs.
 *
 * @returns A styled dropdown select element for language selection
 */
export const LanguageSelector = (): ReactElement | null => {
  const { language, setLanguage } = useLanguageStore();

  const handleLanguageChange = (newLanguage: ProgrammingLanguage) => {
    setLanguage(newLanguage);
  };

  return (
    <div className="relative mt-1">
      <select
        value={language}
        onChange={(e) =>
          handleLanguageChange(e.target.value as ProgrammingLanguage)
        }
        className="px-3 py-2 text-sm font-medium border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors cursor-pointer min-w-[120px] pr-8"
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
        }}
      >
        {buildOptions()}
      </select>
      <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
        <svg
          className="w-4 h-4 text-gray-500 dark:text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </div>
    </div>
  );
};

function buildOptions() {
  const options: {
    value: ProgrammingLanguage;
    label: string;
  }[] = [
    { value: "python", label: "Python" },
    { value: "typescript", label: "TypeScript" },
    { value: "go", label: "Go" },
  ];
  return options.map((option) => (
    <option key={option.value} value={option.value} id={option.value}>
      {option.label}
    </option>
  ));
}
