import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_SETTINGS, DEFAULT_VISIBLE_COLUMNS, type DashboardSettings } from "@/domain/settings";
import {
  tableStateFromSettings,
  visibilityStateFromVisibleColumns,
  visibleColumnsFromVisibilityState,
} from "./settings-mapping";

describe("column visibility mapping", () => {
  it("marks optional columns hidden and keeps the rest visible for the default set", () => {
    const visibility = visibilityStateFromVisibleColumns([...DEFAULT_VISIBLE_COLUMNS]);

    expect(visibility.currentTask).toBe(true);
    expect(visibility.model).toBe(false);
    expect(visibility.tokens).toBe(false);
    // Always-on columns are never toggled, so they get no entry.
    expect(visibility.select).toBeUndefined();
    expect(visibility.actions).toBeUndefined();
  });

  it("round-trips the default visible-column list", () => {
    const visibility = visibilityStateFromVisibleColumns([...DEFAULT_VISIBLE_COLUMNS]);
    expect(visibleColumnsFromVisibilityState(visibility)).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
  });

  it("treats an absent entry as visible and a false entry as hidden", () => {
    expect(visibleColumnsFromVisibilityState({ model: true, tokens: false })).toContain("model");
    expect(visibleColumnsFromVisibilityState({ model: true, tokens: false })).not.toContain("tokens");
  });
});

describe("tableStateFromSettings", () => {
  it("maps every persisted slice onto the table's own shape", () => {
    const settings: DashboardSettings = {
      ...DEFAULT_DASHBOARD_SETTINGS,
      rowDensity: "comfortable",
      sort: [{ id: "status", desc: true }],
      columnWidths: { agent: 220 },
      statusFilter: ["failed", "running"],
      projectFilter: ["/tmp/project"],
      branchFilter: ["main"],
      visibleColumns: [...DEFAULT_VISIBLE_COLUMNS],
    };

    const state = tableStateFromSettings(settings);

    expect(state.density).toBe("comfortable");
    expect(state.sorting).toEqual([{ id: "status", desc: true }]);
    expect(state.columnSizing).toEqual({ agent: 220 });
    expect(state.statusKinds).toEqual(["failed", "running"]);
    expect(state.projectCwds).toEqual(["/tmp/project"]);
    expect(state.branches).toEqual(["main"]);
    expect(state.columnVisibility.model).toBe(false);
  });

  it("drops status filter entries that are not valid status kinds", () => {
    const settings: DashboardSettings = {
      ...DEFAULT_DASHBOARD_SETTINGS,
      statusFilter: ["failed", "not-a-real-kind"],
    };

    expect(tableStateFromSettings(settings).statusKinds).toEqual(["failed"]);
  });
});
