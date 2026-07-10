"use client";

import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useCallback, useMemo, useState } from "react";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { Incident } from "@/domain/incident/incident";
import { useDashboardSnapshot } from "@/lib/query/use-dashboard-snapshot";
import { useRealtimeSync } from "@/lib/query/use-realtime-sync";
import { deriveCriticalIncidents, deriveProjectNavEntries } from "./selectors";
import { DashboardAppShell } from "./shell/dashboard-app-shell";
import type { DashboardView } from "./shell/side-nav";

export function DashboardRoot() {
  const { data, isLoading, isError, error } = useDashboardSnapshot();
  const { status: connectionStatus } = useRealtimeSync();

  const [statusFilter, setStatusFilter] = useState<AgentStatusKind[]>([]);
  const [selectedView, setSelectedView] = useState<DashboardView>("all");
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);

  const toggleStatusFilter = useCallback((status: AgentStatusKind) => {
    setStatusFilter((current) =>
      current.includes(status) ? current.filter((value) => value !== status) : [...current, status],
    );
  }, []);

  const projects = useMemo(() => (data ? deriveProjectNavEntries(data) : []), [data]);
  const criticalIncidents = useMemo(() => (data ? deriveCriticalIncidents(data.incidents) : []), [data]);

  const handleSelectIncident = useCallback((incident: Incident) => {
    setSelectedView({ projectCwd: incident.affectedProjectIds[0] ?? "" });
  }, []);

  if (isLoading || !data) {
    return (
      <Center height="100vh">
        <Spinner size="lg" label="대시보드를 불러오는 중" />
      </Center>
    );
  }

  if (isError) {
    return (
      <Center height="100vh">
        <Text type="body">대시보드를 불러오지 못했습니다: {error instanceof Error ? error.message : "알 수 없는 오류"}</Text>
      </Center>
    );
  }

  return (
    <DashboardAppShell
      summary={data.summary}
      statusFilter={statusFilter}
      onToggleStatusFilter={toggleStatusFilter}
      connectionStatus={connectionStatus}
      lastSyncedAt={data.lastSyncedAt}
      onOpenCommandPalette={() => {
        /* Command palette lands in a later task; trigger is wired now so the button isn't dead. */
      }}
      isSidebarCollapsed={isSidebarCollapsed}
      onSidebarCollapsedChange={setSidebarCollapsed}
      selectedView={selectedView}
      onSelectAll={() => setSelectedView("all")}
      onSelectIncidents={() => setSelectedView("incidents")}
      onSelectProject={(cwd) => setSelectedView({ projectCwd: cwd })}
      projects={projects}
      criticalIncidents={criticalIncidents}
      onSelectIncident={handleSelectIncident}
    >
      <Text type="supporting">운영 테이블은 다음 단계에서 연결됩니다. 현재 에이전트 수: {data.allIds.length}</Text>
    </DashboardAppShell>
  );
}
