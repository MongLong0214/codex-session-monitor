import type { ColumnSizingState, SortingState, VisibilityState } from "@tanstack/react-table";
import { AgentStatusKindSchema, type AgentStatusKind } from "@/domain/agent/status";
import type { DashboardSettings, RowDensity } from "@/domain/settings";
import { agentTableColumns, getHideableColumnIds } from "./columns";

const VALID_STATUS_KINDS = new Set<string>(AgentStatusKindSchema.options);

function isAgentStatusKind(value: string): value is AgentStatusKind {
  return VALID_STATUS_KINDS.has(value);
}

/**
 * The persisted slices of the table state, in the table's own runtime shape rather than the
 * settings shape. `useAgentTableState` seeds its `useState` calls from this on hydration, and
 * writes each slice back through the `onPersist` callback (which reshapes to DashboardSettings).
 */
export interface PersistedTableState {
  density: RowDensity;
  sorting: SortingState;
  columnVisibility: VisibilityState;
  columnSizing: ColumnSizingState;
  statusKinds: AgentStatusKind[];
  projectCwds: string[];
  branches: string[];
}

/**
 * settings.visibleColumns is a flat list of *visible* column ids; the table tracks visibility as a
 * record where absent/true means shown and false means hidden. Only hideable columns get an entry
 * — the always-on columns (select/status/agent/actions) are never toggled — which matches exactly
 * what table-toolbar.tsx writes when the user changes column visibility.
 */
export function visibilityStateFromVisibleColumns(visibleColumns: readonly string[]): VisibilityState {
  return Object.fromEntries(getHideableColumnIds().map((columnId) => [columnId, visibleColumns.includes(columnId)]));
}

/** Inverse of visibilityStateFromVisibleColumns: every column not explicitly hidden is visible. */
export function visibleColumnsFromVisibilityState(columnVisibility: VisibilityState): string[] {
  return agentTableColumns
    .map((column) => column.id ?? "")
    .filter((columnId) => columnId !== "" && columnVisibility[columnId] !== false);
}

/**
 * Projects persisted DashboardSettings onto the table state's own shape for hydration. `sort` and
 * `columnWidths` already match TanStack's `SortingState`/`ColumnSizingState` verbatim, so only the
 * column-visibility translation and a defensive filter of unknown status kinds are needed.
 */
export function tableStateFromSettings(settings: DashboardSettings): PersistedTableState {
  return {
    density: settings.rowDensity,
    sorting: settings.sort,
    columnVisibility: visibilityStateFromVisibleColumns(settings.visibleColumns),
    columnSizing: settings.columnWidths,
    statusKinds: settings.statusFilter.filter(isAgentStatusKind),
    projectCwds: settings.projectFilter,
    branches: settings.branchFilter,
  };
}
