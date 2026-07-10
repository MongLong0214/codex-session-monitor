import type { DashboardSnapshot } from "@/domain/dashboard";
import type { Incident } from "@/domain/incident/incident";
import type { ProjectNavEntry } from "./shell/side-nav";

const ERROR_STATUS_KINDS = new Set(["failed", "blocked", "stale"]);

/** Sidebar aggregation — small and infrequent enough not to need the table's reference-stability rules. */
export function deriveProjectNavEntries(snapshot: DashboardSnapshot): ProjectNavEntry[] {
  const byCwd = new Map<string, ProjectNavEntry>();

  for (const project of snapshot.projects) {
    byCwd.set(project.cwd, { project, runningCount: 0, errorCount: 0 });
  }

  for (const id of snapshot.allIds) {
    const agent = snapshot.byId[id];
    if (!agent) {
      continue;
    }
    const entry = byCwd.get(agent.project.cwd);
    if (!entry) {
      continue;
    }
    if (agent.status.kind === "running") {
      entry.runningCount += 1;
    }
    if (ERROR_STATUS_KINDS.has(agent.status.kind)) {
      entry.errorCount += 1;
    }
  }

  return [...byCwd.values()].sort((a, b) => a.project.name.localeCompare(b.project.name));
}

export function deriveCriticalIncidents(incidents: Incident[]): Incident[] {
  return incidents
    .filter((incident) => incident.severity === "critical" || incident.severity === "high")
    .sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "critical" ? -1 : 1;
      }
      return b.detectedAt.localeCompare(a.detectedAt);
    });
}
