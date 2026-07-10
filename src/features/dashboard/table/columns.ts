import type { ColumnDef, ColumnSizingState, VisibilityState } from "@tanstack/react-table";
import type { AgentId } from "@/domain/agent/agent";
import type { RowDensity } from "@/domain/settings";
import { DEFAULT_VISIBLE_COLUMNS, OPTIONAL_HIDDEN_COLUMNS } from "@/domain/settings";
import { isSortableColumn } from "./filter-sort";

/** Derived from settings.ts so a renamed column breaks the build here rather than silently at runtime. */
export type AgentTableColumnId =
  | (typeof DEFAULT_VISIBLE_COLUMNS)[number]
  | (typeof OPTIONAL_HIDDEN_COLUMNS)[number];

/**
 * Rows are a fixed height, so the virtualizer's `estimateSize` returns this exact value rather
 * than an estimate — no measurement pass, no layout shift. The number is handed to CSS as
 * `--row-height` so the stylesheet and the virtualizer can never disagree.
 */
export const ROW_HEIGHT_PX: Record<RowDensity, number> = {
  compact: 34,
  comfortable: 40,
};

/**
 * Pinned through horizontal scroll: the checkbox, the status and the agent name. Everything the
 * user needs to keep identifying a row while reading far-right columns.
 */
export const STICKY_COLUMN_IDS: readonly string[] = ["select", "status", "agent"];

/** Right-aligned so digits line up down the column; paired with `hasTabularNumbers` on the Text. */
const END_ALIGNED_COLUMN_IDS: readonly string[] = ["runningTime", "cost", "tokens", "retryCount"];

const DEFAULT_COLUMN_SIZE = 150;

export const COLUMN_LABELS: Record<AgentTableColumnId, string> = {
  select: "선택",
  status: "상태",
  agent: "에이전트",
  projectBranch: "프로젝트 / 브랜치",
  currentTask: "현재 작업",
  progress: "진행",
  recentActivity: "최근 활동",
  runningTime: "실행 시간",
  cost: "비용",
  model: "모델",
  tokens: "토큰",
  retryCount: "재시도",
  heartbeat: "하트비트",
  runtimeId: "PID",
  actions: "작업",
};

/**
 * `ColumnDef<AgentId>` — the row model holds ids, never `Agent` objects. Cells are rendered from
 * the `Agent` each row resolves for itself (see agent-table-row.tsx), so no `cell` renderer is
 * declared here; these defs own identity, sizing, resizing, sorting and hiding.
 *
 * Column ids are the contract with `domain/settings.ts` (DEFAULT_VISIBLE_COLUMNS /
 * OPTIONAL_HIDDEN_COLUMNS) so a later task can persist visibility and widths verbatim.
 * columns.test.ts fails if the two drift apart.
 */
const BASE_COLUMNS: ColumnDef<AgentId>[] = [
  { id: "select", header: COLUMN_LABELS.select, size: 44, enableResizing: false, enableHiding: false },
  { id: "status", header: COLUMN_LABELS.status, size: 116, minSize: 96, enableHiding: false },
  { id: "agent", header: COLUMN_LABELS.agent, size: 240, minSize: 140, enableHiding: false },
  { id: "projectBranch", header: COLUMN_LABELS.projectBranch, size: 200, minSize: 120 },
  { id: "currentTask", header: COLUMN_LABELS.currentTask, size: 320, minSize: 140 },
  { id: "progress", header: COLUMN_LABELS.progress, size: 120, minSize: 80 },
  { id: "recentActivity", header: COLUMN_LABELS.recentActivity, size: 140, minSize: 100 },
  { id: "runningTime", header: COLUMN_LABELS.runningTime, size: 108, minSize: 80 },
  { id: "cost", header: COLUMN_LABELS.cost, size: 96, minSize: 72 },
  { id: "model", header: COLUMN_LABELS.model, size: 150, minSize: 100 },
  { id: "tokens", header: COLUMN_LABELS.tokens, size: 100, minSize: 72 },
  { id: "retryCount", header: COLUMN_LABELS.retryCount, size: 88, minSize: 72 },
  { id: "heartbeat", header: COLUMN_LABELS.heartbeat, size: 140, minSize: 100 },
  { id: "runtimeId", header: COLUMN_LABELS.runtimeId, size: 120, minSize: 80 },
  { id: "actions", header: COLUMN_LABELS.actions, size: 96, enableResizing: false, enableHiding: false },
];

/** `enableSorting` is derived from the comparator table, so a column can never claim a sort it lacks. */
export const agentTableColumns: ColumnDef<AgentId>[] = BASE_COLUMNS.map((column) => ({
  ...column,
  enableSorting: isSortableColumn(column.id ?? ""),
}));

/**
 * VisibilityState only needs the `false` entries; anything absent is visible. Model, tokens,
 * retry count, heartbeat and PID are diagnostics — off until the user asks for them.
 */
export const DEFAULT_COLUMN_VISIBILITY: VisibilityState = Object.fromEntries(
  OPTIONAL_HIDDEN_COLUMNS.map((columnId) => [columnId, false]),
);

export function getHideableColumnIds(): string[] {
  return agentTableColumns.filter((column) => column.enableHiding !== false).map((column) => column.id ?? "");
}

export interface ColumnLayout {
  id: string;
  size: number;
  /** Pixel offset for `position: sticky; left: …`, or null for a normally-scrolling column. */
  stickyLeft: number | null;
  isEndAligned: boolean;
}

/**
 * The single source of truth for every rendered width — header cells and body cells both read it,
 * so a resize can never leave them misaligned. It is memoized on `columnVisibility`/`columnSizing`
 * alone (both stable object references between renders), which keeps the resulting array stable
 * enough to pass through `memo()`'d rows without defeating them.
 *
 * Mirrors TanStack's own resolution order (`columnSizing[id] ?? columnDef.size ?? default`).
 */
export function buildColumnLayout(
  columnVisibility: VisibilityState,
  columnSizing: ColumnSizingState,
): ColumnLayout[] {
  const layout: ColumnLayout[] = [];
  let stickyOffset = 0;
  let isStickyRun = true;

  for (const column of agentTableColumns) {
    const id = column.id ?? "";
    if (columnVisibility[id] === false) {
      continue;
    }

    const size = columnSizing[id] ?? column.size ?? DEFAULT_COLUMN_SIZE;
    // The sticky run has to be contiguous from the left edge; a gap would leave a floating column.
    isStickyRun = isStickyRun && STICKY_COLUMN_IDS.includes(id);

    layout.push({
      id,
      size,
      stickyLeft: isStickyRun ? stickyOffset : null,
      isEndAligned: END_ALIGNED_COLUMN_IDS.includes(id),
    });

    if (isStickyRun) {
      stickyOffset += size;
    }
  }

  return layout;
}

export function getTableWidth(layout: ColumnLayout[]): number {
  return layout.reduce((total, column) => total + column.size, 0);
}
