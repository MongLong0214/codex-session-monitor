import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBLE_COLUMNS, OPTIONAL_HIDDEN_COLUMNS } from "@/domain/settings";
import {
  agentTableColumns,
  buildColumnLayout,
  COLUMN_LABELS,
  DEFAULT_COLUMN_VISIBILITY,
  getHideableColumnIds,
  getTableWidth,
  ROW_HEIGHT_PX,
  STICKY_COLUMN_IDS,
} from "./columns";

const columnIds = agentTableColumns.map((column) => column.id ?? "");

describe("column defs vs domain/settings contract", () => {
  it("defines every default-visible and optional-hidden column, and nothing else", () => {
    const expected = [...DEFAULT_VISIBLE_COLUMNS, ...OPTIONAL_HIDDEN_COLUMNS].sort();
    expect([...columnIds].sort()).toEqual(expected);
  });

  it("renders the default-visible columns in the settings-defined order", () => {
    const visibleInOrder = columnIds.filter((id) => (DEFAULT_VISIBLE_COLUMNS as readonly string[]).includes(id));
    expect(visibleInOrder).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
  });

  it("labels every column", () => {
    for (const id of columnIds) {
      expect(COLUMN_LABELS[id as keyof typeof COLUMN_LABELS]).toBeTruthy();
    }
  });
});

describe("DEFAULT_COLUMN_VISIBILITY", () => {
  it("hides exactly the optional columns by default", () => {
    expect(DEFAULT_COLUMN_VISIBILITY).toEqual({
      model: false,
      tokens: false,
      retryCount: false,
      heartbeat: false,
      runtimeId: false,
    });
  });

  it("marks no default-visible column hidden", () => {
    for (const id of DEFAULT_VISIBLE_COLUMNS) {
      expect(DEFAULT_COLUMN_VISIBILITY[id]).toBeUndefined();
    }
  });
});

describe("getHideableColumnIds", () => {
  it("excludes the structural columns that cannot be hidden", () => {
    const hideable = getHideableColumnIds();
    expect(hideable).not.toContain("select");
    expect(hideable).not.toContain("status");
    expect(hideable).not.toContain("agent");
    expect(hideable).not.toContain("actions");
    expect(hideable).toContain("cost");
    expect(hideable).toContain("model");
  });
});

describe("buildColumnLayout", () => {
  it("drops hidden columns", () => {
    const layout = buildColumnLayout(DEFAULT_COLUMN_VISIBILITY, {});
    const ids = layout.map((column) => column.id);
    expect(ids).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
    expect(ids).not.toContain("model");
  });

  it("assigns cumulative sticky offsets to the leading pinned run only", () => {
    const layout = buildColumnLayout(DEFAULT_COLUMN_VISIBILITY, {});
    const select = layout.find((column) => column.id === "select");
    const status = layout.find((column) => column.id === "status");
    const agent = layout.find((column) => column.id === "agent");
    const project = layout.find((column) => column.id === "projectBranch");

    expect(select?.stickyLeft).toBe(0);
    expect(status?.stickyLeft).toBe(select?.size);
    expect(agent?.stickyLeft).toBe((select?.size ?? 0) + (status?.size ?? 0));
    // The first non-sticky column and everything after it scroll normally.
    expect(project?.stickyLeft).toBeNull();
  });

  it("only pins the documented sticky columns", () => {
    const layout = buildColumnLayout(DEFAULT_COLUMN_VISIBILITY, {});
    for (const column of layout) {
      if (column.stickyLeft !== null) {
        expect(STICKY_COLUMN_IDS).toContain(column.id);
      }
    }
  });

  it("prefers a user-set width from columnSizing over the column default", () => {
    const layout = buildColumnLayout(DEFAULT_COLUMN_VISIBILITY, { agent: 400 });
    expect(layout.find((column) => column.id === "agent")?.size).toBe(400);
  });

  it("marks numeric columns end-aligned", () => {
    const layout = buildColumnLayout({}, {});
    expect(layout.find((column) => column.id === "cost")?.isEndAligned).toBe(true);
    expect(layout.find((column) => column.id === "runningTime")?.isEndAligned).toBe(true);
    expect(layout.find((column) => column.id === "agent")?.isEndAligned).toBe(false);
  });
});

describe("getTableWidth", () => {
  it("sums every visible column width", () => {
    const layout = buildColumnLayout(DEFAULT_COLUMN_VISIBILITY, {});
    const expected = layout.reduce((total, column) => total + column.size, 0);
    expect(getTableWidth(layout)).toBe(expected);
    expect(getTableWidth(layout)).toBeGreaterThan(0);
  });
});

describe("ROW_HEIGHT_PX", () => {
  it("is a fixed pixel value per density, comfortable taller than compact", () => {
    expect(ROW_HEIGHT_PX.compact).toBe(34);
    expect(ROW_HEIGHT_PX.comfortable).toBe(40);
  });
});
