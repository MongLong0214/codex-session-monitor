"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  DASHBOARD_SETTINGS_STORAGE_KEY,
  DEFAULT_DASHBOARD_SETTINGS,
  parseDashboardSettings,
  type DashboardSettings,
} from "@/domain/settings";

/**
 * Reads and validates the persisted dashboard settings. Every failure mode — no `window` (SSR),
 * a private-mode `localStorage` whose getter throws, malformed JSON, or a shape that no longer
 * matches the schema — resolves to DEFAULT_DASHBOARD_SETTINGS instead of throwing, so a corrupted
 * or inaccessible store can never break the dashboard. `parseDashboardSettings` owns the shape
 * validation; this only owns the storage access and JSON decode.
 */
export function readStoredSettings(): DashboardSettings {
  if (typeof window === "undefined") {
    return DEFAULT_DASHBOARD_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(DASHBOARD_SETTINGS_STORAGE_KEY);
    return raw === null ? DEFAULT_DASHBOARD_SETTINGS : parseDashboardSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_DASHBOARD_SETTINGS;
  }
}

/** Persists settings, degrading to a silent no-op when storage is unavailable (private mode, quota). */
export function writeStoredSettings(settings: DashboardSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(DASHBOARD_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota: keep the in-memory value, never surface the write failure.
  }
}

export interface PersistedSettings {
  settings: DashboardSettings;
  /** Merges a partial patch into the current settings and writes the result back to storage. */
  updateSettings: (patch: Partial<DashboardSettings>) => void;
  /**
   * False on the SSR-matching first render, true once the store's client snapshot is surfaced
   * after hydration. Gate any state that must initialize from persisted values on this flag, so its
   * `useState` initializer runs against the real settings rather than the defaults shown before.
   */
  isHydrated: boolean;
}

interface SettingsSnapshot {
  settings: DashboardSettings;
  isHydrated: boolean;
}

/** Stable server/hydration snapshot: no window is read, so the client's first render matches SSR. */
const SERVER_SNAPSHOT: SettingsSnapshot = { settings: DEFAULT_DASHBOARD_SETTINGS, isHydrated: false };

interface SettingsStore {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => SettingsSnapshot;
  getServerSnapshot: () => SettingsSnapshot;
  update: (patch: Partial<DashboardSettings>) => void;
}

/**
 * A localStorage-backed external store consumed through `useSyncExternalStore`. This is the
 * SSR-safe alternative to a hydrate-in-effect: React uses `getServerSnapshot` for the first
 * (SSR-matching) render and only reads `getSnapshot` after hydration, so the stored value surfaces
 * post-mount without a manual `setState` inside an effect. The snapshot object is cached so repeated
 * reads return a stable reference; `update` replaces the cache directly, which is also what keeps a
 * failed write (private mode / quota) reflected in memory even though nothing reached localStorage.
 */
function createSettingsStore(): SettingsStore {
  let snapshot: SettingsSnapshot | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);
      // Cross-tab: another tab writing (or clearing, key === null) refreshes this tab.
      const onStorage = (event: StorageEvent) => {
        if (event.key === DASHBOARD_SETTINGS_STORAGE_KEY || event.key === null) {
          snapshot = { settings: readStoredSettings(), isHydrated: true };
          emit();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(onStoreChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot() {
      if (snapshot === null) {
        snapshot = { settings: readStoredSettings(), isHydrated: true };
      }
      return snapshot;
    },
    getServerSnapshot() {
      return SERVER_SNAPSHOT;
    },
    update(patch) {
      const current = snapshot?.settings ?? readStoredSettings();
      const next = { ...current, ...patch };
      writeStoredSettings(next);
      snapshot = { settings: next, isHydrated: true };
      emit();
    },
  };
}

/**
 * SSR-safe persisted settings. The first render returns DEFAULT_DASHBOARD_SETTINGS with
 * `isHydrated: false`; once hydration completes the stored value is surfaced and `isHydrated` flips
 * to true. Writes go through `updateSettings`, which updates the store and persists in one step.
 */
export function usePersistedSettings(): PersistedSettings {
  // Lazy `useState` initializer (not `useRef`) so the store is created once and read render-safely.
  const [store] = useState(createSettingsStore);

  const { settings, isHydrated } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  const updateSettings = useCallback((patch: Partial<DashboardSettings>) => store.update(patch), [store]);

  return { settings, updateSettings, isHydrated };
}
