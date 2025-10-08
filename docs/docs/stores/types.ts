/**
 * Supported programming languages for code examples
 */
export type ProgrammingLanguage = "python" | "typescript" | "go";

/**
 * Storage key constant for language preference persistence
 */
export const LANGUAGE_STORAGE_KEY = "codegroup-selected-tab";

/**
 * Custom event name for cross-component language synchronization
 * Used for backward compatibility with components not yet using Zustand
 */
export const LANGUAGE_CHANGE_EVENT = "codegroup-storage-change";
