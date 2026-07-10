"use client";

import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { TopNav } from "@astryxdesign/core/TopNav";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { DashboardSummary } from "@/domain/dashboard";
import type { ConnectionStatus } from "@/lib/realtime/transport";
import { CONNECTION_DOT_VARIANT, CONNECTION_LABEL } from "../status-presentation";
import { StatusCounters } from "./status-counters";

interface TopBarProps {
  summary: DashboardSummary;
  statusFilter: AgentStatusKind[];
  onToggleStatusFilter: (status: AgentStatusKind) => void;
  connectionStatus: ConnectionStatus;
  lastSyncedAt: string | null;
  onOpenCommandPalette: () => void;
}

export function TopBar({
  summary,
  statusFilter,
  onToggleStatusFilter,
  connectionStatus,
  lastSyncedAt,
  onOpenCommandPalette,
}: TopBarProps) {
  return (
    <TopNav
      label="대시보드 상단 바"
      heading={<Text type="label">Codex Session Monitor</Text>}
      centerContent={
        <StatusCounters summary={summary} activeFilter={statusFilter} onToggleFilter={onToggleStatusFilter} />
      }
      endContent={
        <HStack gap={3} vAlign="center">
          <HStack gap={1} vAlign="center">
            <StatusDot
              variant={CONNECTION_DOT_VARIANT[connectionStatus]}
              label={CONNECTION_LABEL[connectionStatus]}
              tooltip={CONNECTION_LABEL[connectionStatus]}
            />
            <Text type="supporting">{CONNECTION_LABEL[connectionStatus]}</Text>
          </HStack>
          {lastSyncedAt ? <Timestamp value={lastSyncedAt} format="relative" isLive type="supporting" /> : null}
          <Button
            label="검색 (Ctrl+K)"
            icon={<Icon icon="search" />}
            variant="ghost"
            size="sm"
            onClick={onOpenCommandPalette}
          />
        </HStack>
      }
    />
  );
}
