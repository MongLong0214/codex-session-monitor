"use client";

import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { getCoreRowModel, useReactTable, type Header } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { AgentActionType } from "@/domain/agent/actions";
import type { AgentId, ProjectRef } from "@/domain/agent/agent";
import { useAgentAction, useBulkAgentAction, type OptimisticStatus } from "@/lib/query/use-agent-action";
import { useDashboardSnapshot } from "@/lib/query/use-dashboard-snapshot";
import { AgentTableRow } from "./agent-table-row";
import { BulkActionBar } from "./bulk-action-bar";
import {
  agentTableColumns,
  buildColumnLayout,
  getTableWidth,
  ROW_HEIGHT_PX,
  type ColumnLayout,
} from "./columns";
import { deriveBranchOptions, selectVisibleAgentIds } from "./filter-sort";
import styles from "./operations-table.module.css";
import { TableToolbar } from "./table-toolbar";
import { useAgentTableState, useNowMs } from "./use-table-state";

/** Module-level so an empty snapshot doesn't hand the virtualizer a fresh array every render. */
const EMPTY_AGENT_IDS: AgentId[] = [];
const EMPTY_PROJECTS: ProjectRef[] = [];

const ROW_OVERSCAN = 8;

/**
 * Only pause/resume are safe to predict: the local adapter can genuinely signal a live process.
 * `stop` gets no optimistic patch (its outcome is not predictable), and retry/approve/reject are
 * answered with "skipped" by the local adapter — patching them would render a lie for one frame.
 */
const OPTIMISTIC_STATUS_BY_ACTION: Partial<Record<AgentActionType, OptimisticStatus>> = {
  pause: () => ({ kind: "paused", pausedAt: new Date().toISOString() }),
  resume: (current) => ({
    kind: "running",
    startedAt: current.startedAt,
    lastHeartbeatAt: new Date().toISOString(),
  }),
};

function headerCellStyle(column: ColumnLayout): CSSProperties {
  const style: CSSProperties = { width: column.size };
  if (column.stickyLeft !== null) {
    style.left = column.stickyLeft;
  }
  return style;
}

function headerCellClassName(column: ColumnLayout): string {
  const classNames = [styles.th];
  if (column.stickyLeft !== null) {
    classNames.push(styles.thSticky);
  }
  if (column.isEndAligned) {
    classNames.push(styles.tdEnd);
  }
  return classNames.join(" ");
}

function ariaSortOf(header: Header<AgentId, unknown> | undefined): "ascending" | "descending" | "none" | undefined {
  if (!header?.column.getCanSort()) {
    return undefined;
  }
  const sorted = header.column.getIsSorted();
  if (sorted === "asc") {
    return "ascending";
  }
  if (sorted === "desc") {
    return "descending";
  }
  return "none";
}

function sortIconOf(header: Header<AgentId, unknown>) {
  const sorted = header.column.getIsSorted();
  if (sorted === "asc") {
    return <Icon icon="arrowUp" size="xsm" color="accent" />;
  }
  if (sorted === "desc") {
    return <Icon icon="arrowDown" size="xsm" color="accent" />;
  }
  return <Icon icon="arrowsUpDown" size="xsm" color="disabled" />;
}

export interface OperationsTableProps {
  onOpenDetail: (agentId: AgentId) => void;
}

/**
 * `useToast()` needs a ToastContext. `AppShell` does not mount one yet (its source carries a
 * `TODO: Include root providers (… LayerProvider)`), and without it the hook silently spins up a
 * second React root through `createRoot` and warns. Providing the viewport here keeps that cost
 * out of the app and stays correct if a root-level LayerProvider is added later — the nearest
 * provider wins.
 */
export function OperationsTable({ onOpenDetail }: OperationsTableProps) {
  return (
    <ToastViewport>
      <OperationsTableContent onOpenDetail={onOpenDetail} />
    </ToastViewport>
  );
}

function OperationsTableContent({ onOpenDetail }: OperationsTableProps) {
  const { data } = useDashboardSnapshot();
  const tableState = useAgentTableState();
  const nowMs = useNowMs();
  const showToast = useToast();
  const { mutate: runAgentAction } = useAgentAction();
  const { mutate: runBulkAgentAction, isPending: isBulkActionPending } = useBulkAgentAction();

  const scrollElementRef = useRef<HTMLDivElement>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const isFocusPendingRef = useRef(false);

  const { columnSizing, columnVisibility, density, filters, rowSelection, setRowSelection, sorting } = tableState;

  const visibleAgentIds = useMemo(
    () => (data ? selectVisibleAgentIds(data, filters, sorting) : EMPTY_AGENT_IDS),
    [data, filters, sorting],
  );
  const branchOptions = useMemo(() => (data ? deriveBranchOptions(data) : []), [data]);

  // Stable across realtime events (both slices are unchanged objects unless the user edits them),
  // so memo()'d rows keep their identity check even while the container re-renders.
  const columnLayout = useMemo(() => buildColumnLayout(columnVisibility, columnSizing), [columnVisibility, columnSizing]);

  const table = useReactTable<AgentId>({
    data: visibleAgentIds,
    columns: agentTableColumns,
    getRowId: (agentId) => agentId,
    getCoreRowModel: getCoreRowModel(),
    // Filtering and sorting already happened in selectVisibleAgentIds, against the full snapshot.
    manualFiltering: true,
    manualSorting: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    enableRowSelection: true,
    state: { columnSizing, columnVisibility, rowSelection, sorting },
    onColumnSizingChange: tableState.setColumnSizing,
    onColumnVisibilityChange: tableState.setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onSortingChange: tableState.setSorting,
  });

  const rowHeight = ROW_HEIGHT_PX[density];
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: visibleAgentIds.length,
    getScrollElement: () => scrollElementRef.current,
    // Rows are a fixed height, so this is exact rather than an estimate — no measurement pass.
    estimateSize: () => rowHeight,
    getItemKey: (index) => visibleAgentIds[index] ?? index,
    overscan: ROW_OVERSCAN,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // The parent owns `onOpenDetail` and may recreate it each render; a latest-ref keeps the
  // callback handed to every row referentially stable, which is what memo() compares on.
  const onOpenDetailRef = useRef(onOpenDetail);
  useEffect(() => {
    onOpenDetailRef.current = onOpenDetail;
  });
  const handleOpenDetail = useCallback((agentId: AgentId) => onOpenDetailRef.current(agentId), []);

  const handleToggleSelected = useCallback(
    (agentId: AgentId) => {
      setRowSelection((previous) => {
        if (previous[agentId] === true) {
          const { [agentId]: _removed, ...rest } = previous;
          return rest;
        }
        return { ...previous, [agentId]: true };
      });
    },
    [setRowSelection],
  );

  const handleRowAction = useCallback(
    (agentId: AgentId, action: AgentActionType) => {
      const optimisticStatus = OPTIMISTIC_STATUS_BY_ACTION[action];
      runAgentAction(
        optimisticStatus ? { agentId, request: { action }, optimisticStatus } : { agentId, request: { action } },
        {
          // The local adapter answers retry/approve/reject with "skipped" and an explanation.
          // Surfacing `result.message` verbatim is the honest outcome, not a fabricated success.
          onSuccess: (result) =>
            showToast({
              body: result.message,
              type: result.status === "failed" ? "error" : "info",
              uniqueID: `${result.agentId}:${result.action}`,
            }),
          onError: (error) => showToast({ body: `작업을 실행하지 못했습니다: ${error.message}`, type: "error" }),
        },
      );
    },
    [runAgentAction, showToast],
  );

  const moveFocus = useCallback(
    (nextRowIndex: number) => {
      if (visibleAgentIds.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(nextRowIndex, visibleAgentIds.length - 1));
      isFocusPendingRef.current = true;
      virtualizer.scrollToIndex(clamped);
      setFocusedRowIndex(clamped);
    },
    [virtualizer, visibleAgentIds.length],
  );

  /**
   * Native table semantics plus a roving tabindex — not an ARIA grid, which this table does not
   * implement well enough to claim. Row-level keys only fire when the row itself has focus, so a
   * Space press inside the checkbox or a Enter press on the name button is never hijacked.
   */
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableRowElement>, rowIndex: number) => {
      if (event.target !== event.currentTarget) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(rowIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(rowIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveFocus(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveFocus(visibleAgentIds.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const agentId = visibleAgentIds[rowIndex];
        if (agentId !== undefined) {
          handleOpenDetail(agentId);
        }
      } else if (event.key === " ") {
        event.preventDefault();
        const agentId = visibleAgentIds[rowIndex];
        if (agentId !== undefined) {
          handleToggleSelected(agentId);
        }
      }
    },
    [handleOpenDetail, handleToggleSelected, moveFocus, visibleAgentIds],
  );

  /**
   * Runs after every render on purpose: `scrollToIndex` may need a scroll + re-render before the
   * target row is mounted at all, so the focus attempt has to be retried until the row exists.
   */
  useEffect(() => {
    if (!isFocusPendingRef.current) {
      return;
    }
    const row = scrollElementRef.current?.querySelector<HTMLTableRowElement>(
      `tr[data-row-index="${focusedRowIndex}"]`,
    );
    if (row) {
      isFocusPendingRef.current = false;
      row.focus();
    }
  });

  const selectedAgentIds = table.getSelectedRowModel().rows.map((row) => row.original);

  const handleBulkAction = useCallback(
    (action: AgentActionType) => {
      if (selectedAgentIds.length === 0) {
        return;
      }
      runBulkAgentAction(
        { agentIds: selectedAgentIds, action },
        {
          onSuccess: ({ results }) => {
            const succeeded = results.filter((result) => result.status === "success").length;
            const failed = results.filter((result) => result.status === "failed").length;
            const skipped = results.filter((result) => result.status === "skipped").length;
            showToast({
              body: `${succeeded}건 성공 · ${failed}건 실패 · ${skipped}건 건너뜀`,
              type: failed > 0 ? "error" : "info",
            });
          },
          onError: (error) => showToast({ body: `일괄 작업에 실패했습니다: ${error.message}`, type: "error" }),
        },
      );
    },
    [runBulkAgentAction, selectedAgentIds, showToast],
  );

  if (!data) {
    return null;
  }

  const headersById = new Map(table.getFlatHeaders().map((header) => [header.column.id, header]));
  const virtualRows = virtualizer.getVirtualItems();
  // Out of range while the filtered list is shorter than the last focused index: no row is
  // tabbable, which is correct — there is nothing to focus.
  const activeRowIndex = visibleAgentIds.length === 0 ? -1 : Math.min(focusedRowIndex, visibleAgentIds.length - 1);

  return (
    <div className={styles.root}>
      <TableToolbar
        tableState={tableState}
        projects={data.projects ?? EMPTY_PROJECTS}
        branches={branchOptions}
        visibleRowCount={visibleAgentIds.length}
        totalRowCount={data.allIds.length}
      />

      {selectedAgentIds.length > 0 ? (
        <BulkActionBar
          selectedCount={selectedAgentIds.length}
          isPending={isBulkActionPending}
          onAction={handleBulkAction}
          onClearSelection={() => table.resetRowSelection()}
        />
      ) : null}

      {visibleAgentIds.length === 0 ? (
        <EmptyState
          title="표시할 에이전트가 없습니다"
          description={
            tableState.hasActiveFilters
              ? "필터 조건에 맞는 에이전트가 없습니다. 필터를 초기화해 보세요."
              : "실행 중인 세션이 감지되지 않았습니다."
          }
          icon={<Icon icon="search" size="lg" color="disabled" />}
        />
      ) : (
        <div className={styles.scrollContainer} ref={scrollElementRef}>
          <table
            role="table"
            aria-label="에이전트 운영 테이블"
            aria-rowcount={visibleAgentIds.length + 1}
            className={styles.table}
            style={{ "--row-height": `${rowHeight}px`, width: getTableWidth(columnLayout) } as CSSProperties}
          >
            <thead role="rowgroup" className={styles.thead}>
              <tr role="row" aria-rowindex={1} className={styles.headerRow}>
                {columnLayout.map((column) => {
                  const header = headersById.get(column.id);
                  const canSort = header?.column.getCanSort() ?? false;

                  return (
                    <th
                      key={column.id}
                      role="columnheader"
                      aria-sort={ariaSortOf(header)}
                      className={headerCellClassName(column)}
                      scope="col"
                      style={headerCellStyle(column)}
                    >
                      {column.id === "select" ? (
                        <CheckboxInput
                          label="필터에 해당하는 모든 에이전트 선택"
                          isLabelHidden
                          size="sm"
                          value={
                            table.getIsAllRowsSelected()
                              ? true
                              : table.getIsSomeRowsSelected()
                                ? "indeterminate"
                                : false
                          }
                          onChange={(checked) => table.toggleAllRowsSelected(checked)}
                        />
                      ) : canSort && header ? (
                        <button type="button" className={styles.sortButton} onClick={header.column.getToggleSortingHandler()}>
                          <Text type="supporting" weight="medium" maxLines={1}>
                            {String(header.column.columnDef.header ?? column.id)}
                          </Text>
                          {sortIconOf(header)}
                        </button>
                      ) : (
                        <Text type="supporting" weight="medium" maxLines={1}>
                          {String(header?.column.columnDef.header ?? column.id)}
                        </Text>
                      )}

                      {header?.column.getCanResize() ? (
                        <span
                          className={styles.resizeHandle}
                          data-resizing={header.column.getIsResizing() ? "true" : undefined}
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          role="presentation"
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody role="rowgroup" className={styles.tbody} style={{ height: virtualizer.getTotalSize() }}>
              {virtualRows.map((virtualRow) => {
                const agentId = visibleAgentIds[virtualRow.index];
                if (agentId === undefined) {
                  return null;
                }
                return (
                  <AgentTableRow
                    key={agentId}
                    agentId={agentId}
                    columnLayout={columnLayout}
                    isFocused={virtualRow.index === activeRowIndex}
                    isSelected={rowSelection[agentId] === true}
                    nowMs={nowMs}
                    offsetY={virtualRow.start}
                    onFocusRow={setFocusedRowIndex}
                    onOpenDetail={handleOpenDetail}
                    onRowAction={handleRowAction}
                    onRowKeyDown={handleRowKeyDown}
                    onToggleSelected={handleToggleSelected}
                    rowIndex={virtualRow.index}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
