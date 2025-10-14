import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProgrammingLanguage } from "./types";
import {
  LANGUAGE_STORAGE_KEY,
  LANGUAGE_CHANGE_EVENT,
  PROGRAMMING_LANGUAGES,
} from "../constants";

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
      storage: {
        getItem: (name) => {
          const value = localStorage.getItem(name);
          if (PROGRAMMING_LANGUAGES.includes(value as ProgrammingLanguage)) {
            return {
              state: { language: value as ProgrammingLanguage },
              version: 0,
            };
          }
          return null;
        },
        setItem: (name, value) => {
          localStorage.setItem(name, value.state.language);
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
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
  // Store → Event: Emit for Vocs native CodeGroup
  useLanguageStore.subscribe((state, prevState) => {
    if (state.language !== prevState.language) {
      window.dispatchEvent(
        new CustomEvent(LANGUAGE_CHANGE_EVENT, {
          detail: { value: state.language },
        })
      );
    }
  });

  // Event → Store: Update from Vocs native CodeGroup
  window.addEventListener(LANGUAGE_CHANGE_EVENT, ((e: CustomEvent) => {
    const newValue = e.detail.value;
    if (!newValue) return;
    const current = useLanguageStore.getState();
    if (current.language !== newValue) {
      current.setLanguage(newValue as ProgrammingLanguage);
    }
  }) as EventListener);
}
