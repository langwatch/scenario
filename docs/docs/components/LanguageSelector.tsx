import { type ReactElement, useEffect, useState } from "react";

const STORAGE_KEY = "codegroup-selected-tab";

export const LanguageSelector = (): ReactElement | null => {
  const [selectedLanguage, setSelectedLanguage] = useState<string>("python");

  // Load from localStorage on mount and set up listener
  useEffect(() => {
    const loadFromStorage = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && (stored === "python" || stored === "typescript")) {
          setSelectedLanguage(stored);
        }
      } catch (error) {
        // Handle localStorage access errors (e.g., in SSR or private browsing)
        console.warn(
          "Could not access localStorage for language selector:",
          error
        );
      }
    };

    // Load initial value
    loadFromStorage();

    // Listen for storage changes from other tabs/windows
    const handleStorageChange = (e: StorageEvent) => {
      if (
        e.key === STORAGE_KEY &&
        e.newValue &&
        (e.newValue === "python" || e.newValue === "typescript")
      ) {
        setSelectedLanguage(e.newValue);
      }
    };

    // Listen for custom storage events from same page (from CodeGroup components)
    const handleCustomStorageChange = (e: CustomEvent) => {
      const newValue = e.detail.value;
      if (newValue && (newValue === "python" || newValue === "typescript")) {
        setSelectedLanguage(newValue);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(
      "codegroup-storage-change",
      handleCustomStorageChange as EventListener
    );

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(
        "codegroup-storage-change",
        handleCustomStorageChange as EventListener
      );
    };
  }, []);

  const handleLanguageChange = (language: string) => {
    setSelectedLanguage(language);

    try {
      localStorage.setItem(STORAGE_KEY, language);
      // Dispatch custom event for same-page synchronization with CodeGroup components
      window.dispatchEvent(
        new CustomEvent("codegroup-storage-change", {
          detail: { value: language },
        })
      );
    } catch (error) {
      console.warn(
        "Could not save language preference to localStorage:",
        error
      );
    }
  };

  return (
    <div className="relative mt-1">
      <select
        value={selectedLanguage}
        onChange={(e) => handleLanguageChange(e.target.value)}
        className="px-3 py-2 text-sm font-medium bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors cursor-pointer min-w-[120px] pr-8"
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none'
        }}
      >
        <option value="python">Python</option>
        <option value="typescript">TypeScript</option>
      </select>
      <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
        <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
};
