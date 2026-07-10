import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_SETTINGS, parseDashboardSettings } from "./settings";

describe("parseDashboardSettings", () => {
  it("returns defaults for undefined (first run, nothing in localStorage yet)", () => {
    expect(parseDashboardSettings(undefined)).toEqual(DEFAULT_DASHBOARD_SETTINGS);
  });

  it("returns defaults for corrupted/malformed JSON shapes", () => {
    expect(parseDashboardSettings({ theme: "not-a-real-theme" })).toEqual(DEFAULT_DASHBOARD_SETTINGS);
    expect(parseDashboardSettings("a raw string, not an object")).toEqual(DEFAULT_DASHBOARD_SETTINGS);
    expect(parseDashboardSettings(null)).toEqual(DEFAULT_DASHBOARD_SETTINGS);
  });

  it("returns defaults when schemaVersion is missing or from a future/unknown version", () => {
    const { schemaVersion: _schemaVersion, ...withoutVersion } = DEFAULT_DASHBOARD_SETTINGS;
    expect(parseDashboardSettings(withoutVersion)).toEqual(DEFAULT_DASHBOARD_SETTINGS);
    expect(parseDashboardSettings({ ...DEFAULT_DASHBOARD_SETTINGS, schemaVersion: 99 })).toEqual(
      DEFAULT_DASHBOARD_SETTINGS,
    );
  });

  it("round-trips a valid, fully-populated settings object unchanged", () => {
    const valid = {
      schemaVersion: 1 as const,
      theme: "dark" as const,
      sidebarCollapsed: true,
      rowDensity: "comfortable" as const,
      visibleColumns: ["status", "agent"],
      columnWidths: { agent: 220 },
      statusFilter: ["failed", "blocked"],
      projectFilter: ["/Users/dev/WebstormProjects/v3"],
      branchFilter: ["dev"],
      sort: [{ id: "status", desc: false }],
    };
    expect(parseDashboardSettings(valid)).toEqual(valid);
  });
});
