"use client";

import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { memo, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { AgentActionType } from "@/domain/agent/actions";
import type { Agent, AgentId } from "@/domain/agent/agent";
import { useAgent } from "@/lib/query/use-agent";
import type { ColumnLayout } from "./columns";
import {
  AgentCell,
  CostCell,
  CurrentTaskCell,
  HeartbeatCell,
  ModelCell,
  ProgressCell,
  ProjectBranchCell,
  RecentActivityCell,
  RetryCountCell,
  RowActionsCell,
  RunningTimeCell,
  RuntimeIdCell,
  StatusCell,
  TokensCell,
} from "./table-cells";
import styles from "./operations-table.module.css";

interface AgentTableRowProps {
  agentId: AgentId;
  /** Index within the filtered/sorted id list — drives `aria-rowindex` and the roving tabindex. */
  rowIndex: number;
  offsetY: number;
  columnLayout: ColumnLayout[];
  isSelected: boolean;
  isFocused: boolean;
  nowMs: number;
  onOpenDetail: (agentId: AgentId) => void;
  onToggleSelected: (agentId: AgentId) => void;
  onFocusRow: (rowIndex: number) => void;
  onRowKeyDown: (event: KeyboardEvent<HTMLTableRowElement>, rowIndex: number) => void;
  onRowAction: (agentId: AgentId, action: AgentActionType) => void;
}

function cellStyle(column: ColumnLayout): CSSProperties {
  // Only geometry is inline: widths and sticky offsets are runtime values from the column sizing
  // state, so they cannot live in the stylesheet. Every colour, space and radius is a token there.
  const style: CSSProperties = { width: column.size };
  if (column.stickyLeft !== null) {
    style.left = column.stickyLeft;
  }
  return style;
}

function cellClassName(column: ColumnLayout): string {
  const classNames = [styles.td];
  if (column.stickyLeft !== null) {
    classNames.push(styles.tdSticky);
  }
  if (column.isEndAligned) {
    classNames.push(styles.tdEnd);
  }
  return classNames.join(" ");
}

interface CellContentProps {
  columnId: string;
  agent: Agent;
  isSelected: boolean;
  nowMs: number;
  onOpenDetail: (agentId: AgentId) => void;
  onToggleSelected: (agentId: AgentId) => void;
  onRowAction: (agentId: AgentId, action: AgentActionType) => void;
}

function CellContent({
  columnId,
  agent,
  isSelected,
  nowMs,
  onOpenDetail,
  onToggleSelected,
  onRowAction,
}: CellContentProps): ReactNode {
  if (columnId === "select") {
    return (
      <CheckboxInput
        label={`${agent.displayName} 선택`}
        isLabelHidden
        size="sm"
        value={isSelected}
        onChange={() => onToggleSelected(agent.id)}
      />
    );
  }
  if (columnId === "status") {
    return <StatusCell status={agent.status} />;
  }
  if (columnId === "agent") {
    return <AgentCell agent={agent} onOpenDetail={onOpenDetail} />;
  }
  if (columnId === "projectBranch") {
    return <ProjectBranchCell agent={agent} />;
  }
  if (columnId === "currentTask") {
    return <CurrentTaskCell currentTask={agent.currentTask} />;
  }
  if (columnId === "progress") {
    return <ProgressCell status={agent.status} />;
  }
  if (columnId === "recentActivity") {
    return <RecentActivityCell agent={agent} />;
  }
  if (columnId === "runningTime") {
    return <RunningTimeCell startedAt={agent.startedAt} nowMs={nowMs} />;
  }
  if (columnId === "cost") {
    return <CostCell costUsd={agent.costUsd} />;
  }
  if (columnId === "model") {
    return <ModelCell agent={agent} />;
  }
  if (columnId === "tokens") {
    return <TokensCell tokensUsed={agent.tokensUsed} />;
  }
  if (columnId === "retryCount") {
    return <RetryCountCell status={agent.status} />;
  }
  if (columnId === "heartbeat") {
    return <HeartbeatCell lastHeartbeatAt={agent.lastHeartbeatAt} />;
  }
  if (columnId === "runtimeId") {
    return <RuntimeIdCell runtimePids={agent.runtimePids} />;
  }
  if (columnId === "actions") {
    return <RowActionsCell agent={agent} onAction={onRowAction} />;
  }
  return null;
}

/**
 * `memo()` — one of this codebase's few sanctioned uses, on a perf-critical virtualized row.
 *
 * The row resolves its own agent through `useAgent(agentId)`, which rides the snapshot's cache
 * entry and returns an identical `Agent` reference when some *other* agent changes. So a realtime
 * event re-renders the container (its `allIds`/`summary` subscription fires), `memo()` blocks the
 * re-render from reaching the ~1000 rows whose props are unchanged, and only the one row whose
 * `useAgent` selection actually changed re-renders. Receiving `Agent` as a prop instead would
 * re-render every mounted row on every event.
 */
export const AgentTableRow = memo(function AgentTableRow({
  agentId,
  rowIndex,
  offsetY,
  columnLayout,
  isSelected,
  isFocused,
  nowMs,
  onOpenDetail,
  onToggleSelected,
  onFocusRow,
  onRowKeyDown,
  onRowAction,
}: AgentTableRowProps) {
  const { data: agent } = useAgent(agentId);

  const rowClassNames = [styles.row];
  if (isSelected) {
    rowClassNames.push(styles.rowSelected);
  }

  return (
    <tr
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      className={rowClassNames.join(" ")}
      data-row-index={rowIndex}
      onFocus={() => onFocusRow(rowIndex)}
      onKeyDown={(event) => onRowKeyDown(event, rowIndex)}
      style={{ transform: `translateY(${offsetY}px)` }}
      tabIndex={isFocused ? 0 : -1}
    >
      {agent === undefined ? (
        // The agent was removed between the id list being computed and this row rendering.
        <td role="cell" className={styles.td} style={{ width: "100%" }}>
          <Text type="supporting" color="disabled">
            에이전트가 제거되었습니다
          </Text>
        </td>
      ) : (
        columnLayout.map((column) => (
          <td key={column.id} role="cell" className={cellClassName(column)} style={cellStyle(column)}>
            <CellContent
              agent={agent}
              columnId={column.id}
              isSelected={isSelected}
              nowMs={nowMs}
              onOpenDetail={onOpenDetail}
              onRowAction={onRowAction}
              onToggleSelected={onToggleSelected}
            />
          </td>
        ))
      )}
    </tr>
  );
});
