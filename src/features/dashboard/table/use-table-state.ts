"use client";

import type {
  ColumnSizingState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { RowDensity } from "@/domain/settings";
import { DEFAULT_DASHBOARD_SETTINGS } from "@/domain/settings";
import { DEFAULT_COLUMN_VISIBILITY } from "./columns";
import type { AgentTableFilters } from "./filter-sort";

/** Long enough to skip a burst of keystrokes, short enough that the table still feels live. */
const SEARCH_DEBOUNCE_MS = 200;

/** Elapsed-time cells re-derive from this; a minute is finer than the column's own resolution. */
const NOW_TICK_MS = 30_000;

/**
 * A ticking clock, hoisted so a virtualized row never owns an interval. The container re-renders
 * twice a minute and hands rows a new `nowMs`; a realtime event does not change it, so `memo()`
 * still blocks every row but the one whose agent actually changed.
 */
export function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return nowMs;
}

export interface AgentTableState {
  /** Debounced — this is what the filter predicate reads. */
  filters: AgentTableFilters;
  /** Undebounced — this is what the search input renders. */
  searchInput: string;
  setSearchInput: (search: string) => void;
  setStatusKinds: (statusKinds: AgentStatusKind[]) => void;
  setProjectCwds: (projectCwds: string[]) => void;
  setBranches: (branches: string[]) => void;
  resetFilters: () => void;
  hasActiveFilters: boolean;

  density: RowDensity;
  setDensity: (density: RowDensity) => void;

  sorting: SortingState;
  setSorting: OnChangeFn<SortingState>;
  columnVisibility: VisibilityState;
  setColumnVisibility: OnChangeFn<VisibilityState>;
  columnSizing: ColumnSizingState;
  setColumnSizing: OnChangeFn<ColumnSizingState>;
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
}

/**
 * All table-local state in one place. Every slice is shaped exactly like its `domain/settings.ts`
 * counterpart (`rowDensity`, `visibleColumns`, `columnWidths`, `sort`, and the three filter
 * arrays), so the persistence task can hydrate the initial values and subscribe to the setters
 * without reshaping anything.
 */
export function useAgentTableState(): AgentTableState {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusKinds, setStatusKinds] = useState<AgentStatusKind[]>([]);
  const [projectCwds, setProjectCwds] = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);

  const [density, setDensity] = useState<RowDensity>(DEFAULT_DASHBOARD_SETTINGS.rowDensity);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  const filters = useMemo<AgentTableFilters>(
    () => ({ search, statusKinds, projectCwds, branches }),
    [search, statusKinds, projectCwds, branches],
  );

  const resetFilters = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setStatusKinds([]);
    setProjectCwds([]);
    setBranches([]);
  }, []);

  const hasActiveFilters =
    searchInput !== "" || statusKinds.length > 0 || projectCwds.length > 0 || branches.length > 0;

  return {
    filters,
    searchInput,
    setSearchInput,
    setStatusKinds,
    setProjectCwds,
    setBranches,
    resetFilters,
    hasActiveFilters,
    density,
    setDensity,
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnSizing,
    setColumnSizing,
    rowSelection,
    setRowSelection,
  };
}
