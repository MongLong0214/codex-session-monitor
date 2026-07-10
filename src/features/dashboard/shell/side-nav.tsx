"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/Stack";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import type { ProjectRef } from "@/domain/agent/agent";

export type DashboardView = "all" | "incidents" | { projectCwd: string };

export interface ProjectNavEntry {
  project: ProjectRef;
  runningCount: number;
  errorCount: number;
}

interface DashboardSideNavProps {
  isCollapsed: boolean;
  onCollapsedChange: (isCollapsed: boolean) => void;
  selectedView: DashboardView;
  onSelectAll: () => void;
  onSelectIncidents: () => void;
  onSelectProject: (cwd: string) => void;
  incidentCount: number;
  projects: ProjectNavEntry[];
}

export function DashboardSideNav({
  isCollapsed,
  onCollapsedChange,
  selectedView,
  onSelectAll,
  onSelectIncidents,
  onSelectProject,
  incidentCount,
  projects,
}: DashboardSideNavProps) {
  return (
    <SideNav collapsible={{ isCollapsed, onCollapsedChange, hasButton: true }}>
      <SideNavSection title="개요" isHeaderHidden>
        <SideNavItem label="All Agents" icon="viewColumns" isSelected={selectedView === "all"} onClick={onSelectAll} />
        <SideNavItem
          label="Incidents"
          icon="warning"
          isSelected={selectedView === "incidents"}
          onClick={onSelectIncidents}
          endContent={incidentCount > 0 ? <Badge variant="error" label={incidentCount} /> : undefined}
        />
      </SideNavSection>
      <SideNavSection title="프로젝트">
        {projects.map(({ project, runningCount, errorCount }) => (
          <SideNavItem
            key={project.cwd}
            label={project.name}
            isSelected={typeof selectedView === "object" && selectedView.projectCwd === project.cwd}
            onClick={() => onSelectProject(project.cwd)}
            endContent={
              <HStack gap={1} vAlign="center">
                {errorCount > 0 ? <Badge variant="error" label={errorCount} /> : null}
                <Text type="supporting" hasTabularNumbers>
                  {runningCount}
                </Text>
              </HStack>
            }
          />
        ))}
      </SideNavSection>
    </SideNav>
  );
}
