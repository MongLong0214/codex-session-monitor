import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_SETTINGS_STORAGE_KEY,
  DEFAULT_DASHBOARD_SETTINGS,
  type DashboardSettings,
} from "@/domain/settings";
import { readStoredSettings, usePersistedSettings, writeStoredSettings } from "./use-persisted-settings";

const STORED: DashboardSettings = {
  ...DEFAULT_DASHBOARD_SETTINGS,
  theme: "dark",
  sidebarCollapsed: true,
  rowDensity: "comfortable",
  statusFilter: ["failed"],
};

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("readStoredSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readStoredSettings()).toEqual(DEFAULT_DASHBOARD_SETTINGS);
  });

  it("returns the parsed value for a valid stored payload", () => {
    window.localStorage.setItem(DASHBOARD_SETTINGS_STORAGE_KEY, JSON.stringify(STORED));
    expect(readStoredSettings()).toEqual(STORED);
  });

  it("returns defaults for a non-JSON payload instead of throwing", () => {
    window.localStorage.setItem(DASHBOARD_SETTINGS_STORAGE_KEY, "}{ not json");
    expect(readStoredSettings()).toEqual(DEFAULT_DASHBOARD_SETTINGS);
  });

  it("returns defaults when localStorage.getItem throws (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readStoredSettings()).toEqual(DEFAULT_DASHBOARD_SETTINGS);
  });
});

describe("writeStoredSettings", () => {
  it("round-trips through readStoredSettings", () => {
    writeStoredSettings(STORED);
    expect(readStoredSettings()).toEqual(STORED);
  });

  it("degrades to a no-op when setItem throws (quota/private mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => writeStoredSettings(STORED)).not.toThrow();
  });
});

describe("usePersistedSettings", () => {
  it("hydrates from localStorage after mount", () => {
    window.localStorage.setItem(DASHBOARD_SETTINGS_STORAGE_KEY, JSON.stringify(STORED));

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current.isHydrated).toBe(true);
    expect(result.current.settings).toEqual(STORED);
  });

  it("persists a partial update and reflects it in state and storage", () => {
    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      result.current.updateSettings({ theme: "light", sidebarCollapsed: true });
    });

    expect(result.current.settings.theme).toBe("light");
    expect(result.current.settings.sidebarCollapsed).toBe(true);
    expect(readStoredSettings().theme).toBe("light");
    expect(readStoredSettings().sidebarCollapsed).toBe(true);
  });

  it("keeps updates in memory even when writing to storage fails", () => {
    const { result } = renderHook(() => usePersistedSettings());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    act(() => {
      result.current.updateSettings({ theme: "dark" });
    });

    expect(result.current.settings.theme).toBe("dark");
  });
});
