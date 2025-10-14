/**
 * Map of programming languages to their titles
 */
export const LANGUAGE_TITLE_MAP = {
  python: "Python",
  typescript: "TypeScript",
  go: "Go",
} as const;
/**
 * Supported programming languages for code examples
 */
export const PROGRAMMING_LANGUAGES = Object.keys(LANGUAGE_TITLE_MAP);
/**
 * Storage key constant for language preference persistence
 */
export const LANGUAGE_STORAGE_KEY = "codegroup-selected-tab";

/**
 * Custom event name for cross-component language synchronization
 * Used for backward compatibility with components not yet using Zustand
 */
export const LANGUAGE_CHANGE_EVENT = "codegroup-storage-change";
