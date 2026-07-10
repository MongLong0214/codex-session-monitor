"use client";

import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { Incident } from "@/domain/incident/incident";
import type { DashboardSettings } from "@/domain/settings";
import { useDashboardSnapshot } from "@/lib/query/use-dashboard-snapshot";
import { useRealtimeSync } from "@/lib/query/use-realtime-sync";
import { DashboardWorkspace } from "./dashboard-workspace";
import { deriveCriticalIncidents, deriveProjectNavEntries } from "./selectors";
import { DashboardAppShell } from "./shell/dashboard-app-shell";
import type { DashboardView } from "./shell/side-nav";
import { SEARCH_INPUT_ID } from "./table/table-toolbar";

interface DashboardRootProps {
  settings: DashboardSettings;
  onUpdateSettings: (patch: Partial<DashboardSettings>) => void;
}

/** "/" focuses the table search — but not while the user is already typing into a field. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function DashboardRoot({ settings, onUpdateSettings }: DashboardRootProps) {
  const { data, isLoading, isError, error } = useDashboardSnapshot();
  const { status: connectionStatus } = useRealtimeSync();

  const [statusFilter, setStatusFilter] = useState<AgentStatusKind[]>([]);
  const [selectedView, setSelectedView] = useState<DashboardView>("all");
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const toggleStatusFilter = useCallback((status: AgentStatusKind) => {
    setStatusFilter((current) =>
      current.includes(status) ? current.filter((value) => value !== status) : [...current, status],
    );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        const input = document.getElementById(SEARCH_INPUT_ID);
        if (input instanceof HTMLInputElement) {
          event.preventDefault();
          input.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
      onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      isSidebarCollapsed={settings.sidebarCollapsed}
      onSidebarCollapsedChange={(isCollapsed) => onUpdateSettings({ sidebarCollapsed: isCollapsed })}
      selectedView={selectedView}
      onSelectAll={() => setSelectedView("all")}
      onSelectIncidents={() => setSelectedView("incidents")}
      onSelectProject={(cwd) => setSelectedView({ projectCwd: cwd })}
      projects={projects}
      criticalIncidents={criticalIncidents}
      onSelectIncident={handleSelectIncident}
    >
      <DashboardWorkspace
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        isCommandPaletteOpen={isCommandPaletteOpen}
        onCommandPaletteOpenChange={setCommandPaletteOpen}
      />
    </DashboardAppShell>
  );
}
