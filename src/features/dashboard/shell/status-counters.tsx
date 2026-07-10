"use client";

import { HStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { DashboardSummary } from "@/domain/dashboard";
import { STATUS_DOT_VARIANT, STATUS_LABEL } from "../status-presentation";
import styles from "./status-counters.module.css";

/** Priority order for the top-bar counter row — worst news first, per spec. */
const TOP_BAR_COUNTER_ORDER: AgentStatusKind[] = ["failed", "blocked", "stale", "offline", "running"];

interface StatusCountersProps {
  summary: DashboardSummary;
  activeFilter: AgentStatusKind[];
  onToggleFilter: (status: AgentStatusKind) => void;
}

export function StatusCounters({ summary, activeFilter, onToggleFilter }: StatusCountersProps) {
  return (
    <HStack gap={3} vAlign="center" as="ul" aria-label="에이전트 상태 요약">
      {TOP_BAR_COUNTER_ORDER.map((kind) => {
        const count = summary.statusCounts[kind] ?? 0;
        const isActive = activeFilter.includes(kind);
        return (
          <li key={kind} className={styles.counterItem}>
            <button
              type="button"
              onClick={() => onToggleFilter(kind)}
              aria-pressed={isActive}
              className={styles.counterButton}
            >
              <StatusDot variant={STATUS_DOT_VARIANT[kind]} label={STATUS_LABEL[kind]} />
              <Text type="body">{STATUS_LABEL[kind]}</Text>
              <Text type="supporting" hasTabularNumbers>
                {count}
              </Text>
            </button>
          </li>
        );
      })}
      <Text type="supporting" hasTabularNumbers>
        전체 {summary.totalAgents} · 프로젝트 {summary.activeProjects}
      </Text>
    </HStack>
  );
}
