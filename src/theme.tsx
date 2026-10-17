import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type ThemePreference = "warm" | "night" | "system";
export type ResolvedTheme = "warm" | "night";

export const THEME_STORAGE_KEY = "cozynotes.theme";
export const THEME_EVENT = "cozynotes:theme-changed";

type ThemeState = { preference: ThemePreference; resolvedTheme: ResolvedTheme };
export type ThemeContextValue = ThemeState & { setPreference: (preference: ThemePreference) => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "warm" || value === "night" || value === "system";
}

function storedPreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : "warm";
}

// null distinguishes unavailable storage from an absent or invalid preference.
function readStoredPreference(): ThemePreference | null {
  try {
    return storedPreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistPreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The current window and Tauri synchronization still work without storage.
  }
}

function systemMedia(): MediaQueryList | null {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return null;
  }
}

function themeState(preference: ThemePreference, systemDark?: boolean): ThemeState {
  const resolvedTheme = preference === "system"
    ? (systemDark ?? systemMedia()?.matches ?? false) ? "night" : "warm"
    : preference;
  return { preference, resolvedTheme };
}

function initialTheme(): ThemeState {
  return themeState(readStoredPreference() ?? "warm");
}

function applyTheme(theme: ThemeState) {
  document.documentElement.dataset.theme = theme.resolvedTheme;
  document.documentElement.dataset.themePreference = theme.preference;
}

/** Apply the saved appearance before React renders either kind of window. */
export function initializeTheme() {
  applyTheme(initialTheme());
}

function isTauriWindow() {
  return "__TAURI_INTERNALS__" in window;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);
  const preference = useRef(theme.preference);

  const updateTheme = useCallback((nextPreference: ThemePreference, systemDark?: boolean) => {
    preference.current = nextPreference;
    const next = themeState(nextPreference, systemDark);
    setTheme(current => current.preference === next.preference && current.resolvedTheme === next.resolvedTheme ? current : next);
  }, []);

  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (!isThemePreference(next) || preference.current === next) return;
    updateTheme(next);
    persistPreference(next);
    // Emit only for a local choice, outside React's replayable state updaters.
    if (isTauriWindow()) void emit(THEME_EVENT, next).catch(() => undefined);
  }, [updateTheme]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    const media = systemMedia();
    const onSystemChange = (event: MediaQueryListEvent) => {
      if (!cancelled && preference.current === "system") updateTheme("system", event.matches);
    };
    const onStorage = (event: StorageEvent) => {
      if (cancelled || (event.key !== THEME_STORAGE_KEY && event.key !== null)) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        // A blocked localStorage getter must not prevent a validated update.
      }
      updateTheme(storedPreference(event.key === null ? null : event.newValue));
    };

    window.addEventListener("storage", onStorage);
    media?.addEventListener("change", onSystemChange);
    // Reconcile changes between bootstrap/render and listener attachment.
    updateTheme(readStoredPreference() ?? preference.current, media?.matches);

    if (isTauriWindow()) {
      const registeredPreference = preference.current;
      void listen<unknown>(THEME_EVENT, event => {
        if (cancelled || !isThemePreference(event.payload) || event.payload === preference.current) return;
        updateTheme(event.payload);
        persistPreference(event.payload);
      }).then(dispose => {
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
        // Catch saved changes made while native registration was pending,
        // without replacing a newer local choice or remote event.
        if (preference.current === registeredPreference) {
          const saved = readStoredPreference();
          if (saved !== null) updateTheme(saved);
        }
      }).catch(() => undefined);
    }

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      media?.removeEventListener("change", onSystemChange);
      unlisten?.();
    };
  }, [updateTheme]);

  return <ThemeContext.Provider value={{ ...theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used within a ThemeProvider.");
  return theme;
}
