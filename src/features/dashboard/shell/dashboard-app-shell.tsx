"use client";

import { AppShell } from "@astryxdesign/core/AppShell";
import type { ReactNode } from "react";
import type { AgentStatusKind } from "@/domain/agent/status";
import type { DashboardSummary } from "@/domain/dashboard";
import type { Incident } from "@/domain/incident/incident";
import type { ConnectionStatus } from "@/lib/realtime/transport";
import { IncidentStrip } from "./incident-strip";
import type { DashboardView, ProjectNavEntry } from "./side-nav";
import { DashboardSideNav } from "./side-nav";
import { TopBar } from "./top-bar";

interface DashboardAppShellProps {
  children: ReactNode;
  summary: DashboardSummary;
  statusFilter: AgentStatusKind[];
  onToggleStatusFilter: (status: AgentStatusKind) => void;
  connectionStatus: ConnectionStatus;
  lastSyncedAt: string | null;
  onOpenCommandPalette: () => void;
  isSidebarCollapsed: boolean;
  onSidebarCollapsedChange: (isCollapsed: boolean) => void;
  selectedView: DashboardView;
  onSelectAll: () => void;
  onSelectIncidents: () => void;
  onSelectProject: (cwd: string) => void;
  projects: ProjectNavEntry[];
  criticalIncidents: Incident[];
  onSelectIncident: (incident: Incident) => void;
}

export function DashboardAppShell({
  children,
  summary,
  statusFilter,
  onToggleStatusFilter,
  connectionStatus,
  lastSyncedAt,
  onOpenCommandPalette,
  isSidebarCollapsed,
  onSidebarCollapsedChange,
  selectedView,
  onSelectAll,
  onSelectIncidents,
  onSelectProject,
  projects,
  criticalIncidents,
  onSelectIncident,
}: DashboardAppShellProps) {
  return (
    <AppShell
      contentPadding={0}
      variant="section"
      topNav={
        <TopBar
          summary={summary}
          statusFilter={statusFilter}
          onToggleStatusFilter={onToggleStatusFilter}
          connectionStatus={connectionStatus}
          lastSyncedAt={lastSyncedAt}
          onOpenCommandPalette={onOpenCommandPalette}
        />
      }
      sideNav={
        <DashboardSideNav
          isCollapsed={isSidebarCollapsed}
          onCollapsedChange={onSidebarCollapsedChange}
          selectedView={selectedView}
          onSelectAll={onSelectAll}
          onSelectIncidents={onSelectIncidents}
          onSelectProject={onSelectProject}
          incidentCount={criticalIncidents.length}
          projects={projects}
        />
      }
      banner={
        criticalIncidents.length > 0 ? (
          <IncidentStrip incidents={criticalIncidents} onSelectIncident={onSelectIncident} />
        ) : undefined
      }
    >
      {children}
    </AppShell>
  );
}
