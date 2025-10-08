import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProgrammingLanguage } from "./types";
import { LANGUAGE_STORAGE_KEY, LANGUAGE_CHANGE_EVENT } from "./types";

/**
 * Language store state interface
 */
interface LanguageState {
  /** Currently selected programming language */
  language: ProgrammingLanguage;
}

/**
 * Language store actions interface
 */
interface LanguageActions {
  /** Update the selected programming language */
  setLanguage: (language: ProgrammingLanguage) => void;
}

/**
 * Combined language store interface
 */
export type LanguageStore = LanguageState & LanguageActions;

/**
 * Global language preference store with localStorage persistence
 *
 * Features:
 * - Automatic localStorage sync
 * - Cross-tab synchronization
 * - Type-safe language selection
 * - Backward-compatible event emission for legacy components
 *
 * @example
 * ```tsx
 * const { language, setLanguage } = useLanguageStore();
 *
 * // Read current language
 * console.log(language); // "python" | "typescript"
 *
 * // Update language
 * setLanguage("typescript");
 * ```
 */
export const useLanguageStore = create<LanguageStore>()(
  persist(
    (set) => ({
      language: "python",
      setLanguage: (language) => set({ language }),
    }),
    {
      name: LANGUAGE_STORAGE_KEY,
    }
  )
);

/**
 * Bidirectional synchronization between Zustand store and legacy event system
 *
 * 1. Store → Events: When store changes, emit custom events for legacy components
 * 2. Events → Store: When legacy components emit events, update store
 *
 * This ensures backward compatibility with Vocs' built-in CodeGroup and any
 * other components still using the event-based pattern.
 */
if (typeof window !== "undefined") {
  // Store → Events: Emit events when store changes
  useLanguageStore.subscribe((state, prevState) => {
    // Only emit event if language actually changed
    if (state.language !== prevState.language) {
      window.dispatchEvent(
        new CustomEvent(LANGUAGE_CHANGE_EVENT, {
          detail: { value: state.language },
        })
      );
    }
  });

  // Events → Store: Update store when legacy components emit events
  const handleCustomStorageChange = (e: CustomEvent) => {
    const newValue = e.detail.value;
    if (!newValue) return;
    const currentState = useLanguageStore.getState();
    // Only update if different to avoid circular updates
    if (currentState.language !== newValue) {
      currentState.setLanguage(newValue as ProgrammingLanguage);
    }
  };

  // Listen for storage changes from other browser tabs
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === LANGUAGE_STORAGE_KEY && e.newValue) {
      const currentState = useLanguageStore.getState();
      if (currentState.language !== e.newValue) {
        currentState.setLanguage(e.newValue as ProgrammingLanguage);
      }
    }
  };

  window.addEventListener(
    LANGUAGE_CHANGE_EVENT,
    handleCustomStorageChange as EventListener
  );
  window.addEventListener("storage", handleStorageChange);
}
