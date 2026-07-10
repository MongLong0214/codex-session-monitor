"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { Agent } from "@/domain/agent/agent";
import { STATUS_LABEL } from "../status-presentation";
import styles from "./detail-panel.module.css";
import { EMPTY_VALUE, formatCost, formatElapsed, formatTokens, retryCount, shortCommitSha, statusReason, statusTimestamp } from "./format";

/**
 * Codex emits no percent-complete signal, so a running agent gets an indeterminate bar and a
 * completed one a full success bar. No other state gets a bar at all — a fabricated number would
 * read as authoritative. Confirmed against domain/agent/agent.ts: there is no progress field.
 */
function StatusProgress({ agent }: { agent: Agent }) {
  if (agent.status.kind === "running") {
    return <ProgressBar label="진행 상황(비율 정보 없음)" isIndeterminate />;
  }

  if (agent.status.kind === "completed") {
    return <ProgressBar label="진행 상황" value={100} variant="success" />;
  }

  return null;
}

/** Derived only from parentId/childIds — the domain model has no other dependency concept. */
function RelatedWork({ agent }: { agent: Agent }) {
  if (agent.role === "subagent") {
    return <Badge variant="info" label="상위 세션의 하위 에이전트" />;
  }

  if (agent.childIds.length > 0) {
    return <Badge variant="neutral" label={`하위 에이전트 ${agent.childIds.length}개`} />;
  }

  return <>{EMPTY_VALUE}</>;
}

interface OverviewTabProps {
  agent: Agent;
  /** Injected so elapsed time is computed from one clock per render pass, and stays testable. */
  nowMs: number;
}

export function OverviewTab({ agent, nowMs }: OverviewTabProps) {
  const lastSignalAt = statusTimestamp(agent.status);
  const reason = statusReason(agent.status);
  const retries = retryCount(agent.status);
  const shortSha = shortCommitSha(agent.commitSha);

  return (
    <VStack gap={4}>
      <StatusProgress agent={agent} />

      {reason ? (
        <VStack gap={0.5}>
          <Text type="label">{agent.status.kind === "failed" ? "실패 원인" : "차단 사유"}</Text>
          <Text type="body" as="p" className={styles.wrapAnywhere}>
            {reason}
          </Text>
        </VStack>
      ) : null}

      <MetadataList columns="single" label={{ position: "start", width: 120 }}>
        <MetadataListItem label="상태">{STATUS_LABEL[agent.status.kind]}</MetadataListItem>

        <MetadataListItem label="마지막 신호">
          {lastSignalAt ? <Timestamp value={lastSignalAt} format="relative" isLive /> : EMPTY_VALUE}
        </MetadataListItem>

        <MetadataListItem label="실행 시간">{formatElapsed(agent.startedAt, nowMs)}</MetadataListItem>

        <MetadataListItem label="시작 시각">
          <Timestamp value={agent.startedAt} format="date_time" />
        </MetadataListItem>

        <MetadataListItem label="토큰 사용량">
          <Text type="body" hasTabularNumbers>
            {formatTokens(agent.tokensUsed)}
          </Text>
        </MetadataListItem>

        {/* Null in real/local mode — Codex's state DB has no pricing data. Not a bug. */}
        <MetadataListItem label="비용">
          <Text type="body" hasTabularNumbers>
            {formatCost(agent.costUsd)}
          </Text>
        </MetadataListItem>

        {retries === null ? null : (
          <MetadataListItem label="재시도 횟수">
            <Text type="body" hasTabularNumbers>
              {retries}
            </Text>
          </MetadataListItem>
        )}

        <MetadataListItem label="커밋">
          {shortSha && agent.commitSha ? (
            <Tooltip content={agent.commitSha}>
              <Text type="code">{shortSha}</Text>
            </Tooltip>
          ) : (
            EMPTY_VALUE
          )}
        </MetadataListItem>

        <MetadataListItem label="모델">{agent.model ?? EMPTY_VALUE}</MetadataListItem>
        <MetadataListItem label="추론 강도">{agent.reasoningEffort ?? EMPTY_VALUE}</MetadataListItem>
        <MetadataListItem label="승인 모드">{agent.approvalMode ?? EMPTY_VALUE}</MetadataListItem>
        <MetadataListItem label="CLI 버전">{agent.cliVersion ?? EMPTY_VALUE}</MetadataListItem>

        <MetadataListItem label="연관 작업">
          <RelatedWork agent={agent} />
        </MetadataListItem>

        <MetadataListItem label="프로세스 PID">
          {agent.runtimePids.length > 0 ? <Text type="code">{agent.runtimePids.join(", ")}</Text> : EMPTY_VALUE}
        </MetadataListItem>

        <MetadataListItem label="작업 디렉터리">
          <Text type="code" className={styles.wrapAnywhere}>
            {agent.project.cwd || EMPTY_VALUE}
          </Text>
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}
