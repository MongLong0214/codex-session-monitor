"use client";

import { Button } from "@astryxdesign/core/Button";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { useMemo } from "react";
import type { ProjectRef } from "@/domain/agent/agent";
import { AgentStatusKindSchema, type AgentStatusKind } from "@/domain/agent/status";
import type { RowDensity } from "@/domain/settings";
import { STATUS_LABEL } from "../status-presentation";
import { COLUMN_LABELS, getHideableColumnIds, type AgentTableColumnId } from "./columns";
import styles from "./table-toolbar.module.css";
import type { AgentTableState } from "./use-table-state";

/** Lands on the underlying `<input>` so the global "/" shortcut can focus it via getElementById. */
export const SEARCH_INPUT_ID = "agent-table-search-input";

const STATUS_OPTIONS = AgentStatusKindSchema.options.map((kind) => ({ value: kind, label: STATUS_LABEL[kind] }));

const DENSITY_OPTIONS: { value: RowDensity; label: string }[] = [
  { value: "compact", label: "조밀" },
  { value: "comfortable", label: "여유" },
];

interface TableToolbarProps {
  tableState: AgentTableState;
  projects: ProjectRef[];
  branches: string[];
  visibleRowCount: number;
  totalRowCount: number;
}

/**
 * Filter/view controls for the table. Deliberately does NOT repeat the realtime connection
 * indicator — top-bar.tsx already renders it with a dot, a label and a live timestamp, and a
 * second copy 40px below would be noise, not reassurance.
 *
 * There is no sort control either: sorting is driven by the clickable column headers, which is
 * the standard affordance for a data table and keeps the sorted column visible where it applies.
 */
export function TableToolbar({ tableState, projects, branches, visibleRowCount, totalRowCount }: TableToolbarProps) {
  const {
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
    columnVisibility,
    setColumnVisibility,
  } = tableState;

  const projectOptions = useMemo(
    () => projects.map((project) => ({ value: project.cwd, label: project.name })),
    [projects],
  );
  const branchOptions = useMemo(() => branches.map((branch) => ({ value: branch, label: branch })), [branches]);

  const hideableColumnIds = useMemo(() => getHideableColumnIds(), []);
  const columnOptions = useMemo(
    () =>
      hideableColumnIds.map((columnId) => ({
        value: columnId,
        label: COLUMN_LABELS[columnId as AgentTableColumnId],
      })),
    [hideableColumnIds],
  );
  const visibleColumnIds = useMemo(
    () => hideableColumnIds.filter((columnId) => columnVisibility[columnId] !== false),
    [hideableColumnIds, columnVisibility],
  );

  const handleColumnVisibilityChange = (nextVisibleIds: string[]) => {
    setColumnVisibility(
      Object.fromEntries(hideableColumnIds.map((columnId) => [columnId, nextVisibleIds.includes(columnId)])),
    );
  };

  return (
    <Toolbar
      label="에이전트 테이블 필터"
      size="sm"
      dividers={["bottom"]}
      startContent={
        <>
          <TextInput
            id={SEARCH_INPUT_ID}
            label="에이전트 검색"
            isLabelHidden
            placeholder="이름, 작업, 프로젝트, 브랜치 검색 (/)"
            size="sm"
            startIcon="search"
            hasClear
            value={searchInput}
            onChange={setSearchInput}
          />
          <MultiSelector
            label="상태"
            isLabelHidden
            placeholder="상태"
            size="sm"
            options={STATUS_OPTIONS}
            value={filters.statusKinds}
            onChange={(value) => setStatusKinds(value as AgentStatusKind[])}
          />
          <MultiSelector
            label="프로젝트"
            isLabelHidden
            placeholder="프로젝트"
            size="sm"
            hasSearch
            options={projectOptions}
            value={filters.projectCwds}
            onChange={setProjectCwds}
          />
          <MultiSelector
            label="브랜치"
            isLabelHidden
            placeholder="브랜치"
            size="sm"
            hasSearch
            options={branchOptions}
            value={filters.branches}
            onChange={setBranches}
          />
          {hasActiveFilters ? <Button label="필터 초기화" variant="ghost" size="sm" onClick={resetFilters} /> : null}
        </>
      }
      endContent={
        <>
          <Text type="supporting" hasTabularNumbers>
            {visibleRowCount === totalRowCount ? `${totalRowCount}개` : `${visibleRowCount} / ${totalRowCount}개`}
          </Text>
          <MultiSelector
            label="열 표시"
            isLabelHidden
            placeholder="열"
            size="sm"
            hasSelectAll
            selectAllLabel="전체 표시"
            options={columnOptions}
            value={visibleColumnIds}
            onChange={handleColumnVisibilityChange}
          />
          <SegmentedControl
            label="행 밀도"
            size="sm"
            value={density}
            onChange={(value) => setDensity(value as RowDensity)}
            className={styles.densityControl}
          >
            {DENSITY_OPTIONS.map((option) => (
              <SegmentedControlItem key={option.value} value={option.value} label={option.label} />
            ))}
          </SegmentedControl>
        </>
      }
    />
  );
}
