"use client";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import type { AgentActionType } from "@/domain/agent/actions";
import type { Agent } from "@/domain/agent/agent";
import type { AgentStatus } from "@/domain/agent/status";
import { STATUS_DOT_VARIANT, STATUS_LABEL } from "../status-presentation";
import { agentActivityAt } from "./filter-sort";
import { EM_DASH, formatCostUsd, formatElapsed, formatRuntimePids, formatTokens } from "./format";
import styles from "./operations-table.module.css";

function EmptyValue() {
  return (
    <Text type="supporting" color="disabled">
      {EM_DASH}
    </Text>
  );
}

/** Dot + label, never colour alone: StatusDot's five variants collapse our nine states. */
export function StatusCell({ status }: { status: AgentStatus }) {
  return (
    <HStack gap={1} vAlign="center">
      <StatusDot
        variant={STATUS_DOT_VARIANT[status.kind]}
        label={STATUS_LABEL[status.kind]}
        isPulsing={status.kind === "running"}
      />
      <Text type="supporting" maxLines={1}>
        {STATUS_LABEL[status.kind]}
      </Text>
    </HStack>
  );
}

interface AgentCellProps {
  agent: Agent;
  onOpenDetail: (agentId: string) => void;
}

/**
 * The name is the explicit, and only, control that opens the detail panel — the row itself is
 * never a click target, so a click meant for a checkbox or an action button can't open a panel.
 */
export function AgentCell({ agent, onOpenDetail }: AgentCellProps) {
  const isSubagent = agent.role === "subagent";

  return (
    <HStack gap={1} vAlign="center" className={isSubagent ? styles.subagentIndent : undefined}>
      {isSubagent ? (
        <Text type="supporting" color="disabled" aria-hidden="true">
          ↳
        </Text>
      ) : null}
      <button
        type="button"
        className={styles.detailTrigger}
        onClick={() => onOpenDetail(agent.id)}
        aria-label={`${agent.displayName} 상세 보기`}
      >
        <Text type="body" maxLines={1}>
          {agent.displayName}
        </Text>
      </button>
    </HStack>
  );
}

export function ProjectBranchCell({ agent }: { agent: Agent }) {
  return (
    <VStack gap={0} hAlign="start" className={styles.stackedCell}>
      <Text type="supporting" maxLines={1}>
        {agent.project.name}
      </Text>
      {agent.branch === null ? (
        <EmptyValue />
      ) : (
        <Text type="code" size="sm" color="secondary" maxLines={1}>
          {agent.branch}
        </Text>
      )}
    </VStack>
  );
}

export function CurrentTaskCell({ currentTask }: { currentTask: string | null }) {
  if (currentTask === null) {
    return <EmptyValue />;
  }
  return (
    <Text type="supporting" maxLines={1}>
      {currentTask}
    </Text>
  );
}

/**
 * Codex exposes no percent-complete signal, so this column shows *liveness*, not progress: an
 * indeterminate bar while running, a full success bar once completed, and an em dash otherwise.
 * Inventing a heuristic percentage here would be a lie the rest of this codebase refuses to tell
 * (see the null-cost and null-incident notes in src/data-access).
 */
export function ProgressCell({ status }: { status: AgentStatus }) {
  if (status.kind === "running") {
    return <ProgressBar label="실행 중" isLabelHidden isIndeterminate />;
  }
  if (status.kind === "completed") {
    return <ProgressBar label="완료" isLabelHidden value={100} variant="success" />;
  }
  return <EmptyValue />;
}

export function RecentActivityCell({ agent }: { agent: Agent }) {
  return <Timestamp value={agentActivityAt(agent)} format="relative" isLive type="supporting" />;
}

export function RunningTimeCell({ startedAt, nowMs }: { startedAt: string; nowMs: number }) {
  return (
    <Text type="supporting" hasTabularNumbers>
      {formatElapsed(startedAt, nowMs)}
    </Text>
  );
}

export function CostCell({ costUsd }: { costUsd: number | null }) {
  if (costUsd === null) {
    return <EmptyValue />;
  }
  return (
    <Text type="supporting" hasTabularNumbers>
      {formatCostUsd(costUsd)}
    </Text>
  );
}

export function ModelCell({ agent }: { agent: Agent }) {
  if (agent.model === null) {
    return <EmptyValue />;
  }
  return (
    <Text type="supporting" maxLines={1}>
      {agent.model}
    </Text>
  );
}

export function TokensCell({ tokensUsed }: { tokensUsed: number }) {
  return (
    <Text type="supporting" hasTabularNumbers>
      {formatTokens(tokensUsed)}
    </Text>
  );
}

/** Retry count only exists on the `failed` variant; every other status genuinely has no value. */
export function RetryCountCell({ status }: { status: AgentStatus }) {
  if (status.kind !== "failed") {
    return <EmptyValue />;
  }
  return (
    <Text type="supporting" hasTabularNumbers>
      {status.retryCount}
    </Text>
  );
}

export function HeartbeatCell({ lastHeartbeatAt }: { lastHeartbeatAt: string | null }) {
  if (lastHeartbeatAt === null) {
    return <EmptyValue />;
  }
  return <Timestamp value={lastHeartbeatAt} format="relative" isLive type="supporting" />;
}

export function RuntimeIdCell({ runtimePids }: { runtimePids: number[] }) {
  if (runtimePids.length === 0) {
    return <EmptyValue />;
  }
  return (
    <Text type="code" size="sm" color="secondary" maxLines={1}>
      {formatRuntimePids(runtimePids)}
    </Text>
  );
}

interface QuickAction {
  action: AgentActionType;
  label: string;
}

/**
 * One quick action per status — the one an operator reaches for first. `stop` is deliberately
 * absent: it is destructive and irreversible, so it lives in the overflow menu only.
 */
function quickActionFor(status: AgentStatus): QuickAction | null {
  if (status.kind === "running") {
    return { action: "pause", label: "일시정지" };
  }
  if (status.kind === "paused") {
    return { action: "resume", label: "재개" };
  }
  if (status.kind === "failed") {
    return { action: "retry", label: "재시도" };
  }
  if (status.kind === "approval_required") {
    return { action: "approve", label: "승인" };
  }
  return null;
}

interface RowActionsCellProps {
  agent: Agent;
  onAction: (agentId: string, action: AgentActionType) => void;
}

export function RowActionsCell({ agent, onAction }: RowActionsCellProps) {
  const quickAction = quickActionFor(agent.status);
  const isTerminated = agent.status.kind === "completed" || agent.status.kind === "offline";

  return (
    <HStack gap={0} vAlign="center" hAlign="end" className={styles.actionsCell}>
      {quickAction === null ? null : (
        <Button
          label={quickAction.label}
          variant="ghost"
          size="sm"
          onClick={() => onAction(agent.id, quickAction.action)}
        />
      )}
      <DropdownMenu
        button={{
          label: `${agent.displayName} 추가 작업`,
          icon: <Icon icon="moreHorizontal" />,
          variant: "ghost",
          size: "sm",
          isIconOnly: true,
        }}
        hasChevron={false}
        menuWidth={200}
        items={[
          { label: "재시도", onClick: () => onAction(agent.id, "retry"), isDisabled: isTerminated },
          { label: "승인", onClick: () => onAction(agent.id, "approve"), isDisabled: isTerminated },
          { label: "거부", onClick: () => onAction(agent.id, "reject"), isDisabled: isTerminated },
          { type: "divider" },
          { label: "중지 (SIGTERM)", onClick: () => onAction(agent.id, "stop"), isDisabled: isTerminated },
        ]}
      />
    </HStack>
  );
}
