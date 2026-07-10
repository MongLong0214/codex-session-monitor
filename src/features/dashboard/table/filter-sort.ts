import type { Agent, AgentId } from "@/domain/agent/agent";
import type { AgentStatus, AgentStatusKind } from "@/domain/agent/status";
import { STATUS_SORT_PRIORITY } from "@/domain/agent/status";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { Incident } from "@/domain/incident/incident";

/** Structurally compatible with @tanstack/react-table's `SortingState[number]`, without the import. */
export interface TableSort {
  id: string;
  desc: boolean;
}

export interface AgentTableFilters {
  /** Case-insensitive substring, matched against displayName, currentTask, project name and branch. */
  search: string;
  statusKinds: AgentStatusKind[];
  projectCwds: string[];
  branches: string[];
}

export const EMPTY_AGENT_TABLE_FILTERS: AgentTableFilters = {
  search: "",
  statusKinds: [],
  projectCwds: [],
  branches: [],
};

/**
 * Each status variant carries its own "this is when it last did something" timestamp — there is
 * no shared field. Returns null only for an offline agent that was never seen.
 */
export function statusActivityAt(status: AgentStatus): string | null {
  switch (status.kind) {
    case "running":
      return status.lastHeartbeatAt;
    case "waiting":
      return status.since;
    case "approval_required":
      return status.requestedAt;
    case "blocked":
      return status.since;
    case "failed":
      return status.failedAt;
    case "completed":
      return status.completedAt;
    case "paused":
      return status.pausedAt;
    case "stale":
      return status.lastHeartbeatAt;
    case "offline":
      return status.lastSeenAt;
  }
}

/** `updatedAt` is the honest fallback: the snapshot always has it, even for a never-seen agent. */
export function agentActivityAt(agent: Agent): string {
  return statusActivityAt(agent.status) ?? agent.updatedAt;
}

export function matchesSearch(agent: Agent, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (query === "") {
    return true;
  }

  return (
    agent.displayName.toLowerCase().includes(query) ||
    (agent.currentTask?.toLowerCase().includes(query) ?? false) ||
    agent.project.name.toLowerCase().includes(query) ||
    (agent.branch?.toLowerCase().includes(query) ?? false)
  );
}

/** An empty filter list means "no constraint", not "match nothing". */
export function matchesFilters(agent: Agent, filters: AgentTableFilters): boolean {
  if (filters.statusKinds.length > 0 && !filters.statusKinds.includes(agent.status.kind)) {
    return false;
  }
  if (filters.projectCwds.length > 0 && !filters.projectCwds.includes(agent.project.cwd)) {
    return false;
  }
  if (filters.branches.length > 0 && (agent.branch === null || !filters.branches.includes(agent.branch))) {
    return false;
  }
  return matchesSearch(agent, filters.search);
}

/** Sorts null last in ascending order (and therefore first when the direction is flipped). */
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

function retryCountOf(agent: Agent): number | null {
  return agent.status.kind === "failed" ? agent.status.retryCount : null;
}

/**
 * Ascending-order comparators, keyed by column id. `runningTime` inverts `startedAt` because a
 * *shorter* run is the smaller value, while a later start time is the larger string.
 */
const COLUMN_COMPARATORS: Record<string, (a: Agent, b: Agent) => number> = {
  status: (a, b) => STATUS_SORT_PRIORITY[a.status.kind] - STATUS_SORT_PRIORITY[b.status.kind],
  agent: (a, b) => a.displayName.localeCompare(b.displayName),
  projectBranch: (a, b) =>
    a.project.name.localeCompare(b.project.name) || compareNullableStrings(a.branch, b.branch),
  currentTask: (a, b) => compareNullableStrings(a.currentTask, b.currentTask),
  recentActivity: (a, b) => agentActivityAt(a).localeCompare(agentActivityAt(b)),
  runningTime: (a, b) => b.startedAt.localeCompare(a.startedAt),
  cost: (a, b) => compareNullableNumbers(a.costUsd, b.costUsd),
  model: (a, b) => compareNullableStrings(a.model, b.model),
  tokens: (a, b) => a.tokensUsed - b.tokensUsed,
  retryCount: (a, b) => compareNullableNumbers(retryCountOf(a), retryCountOf(b)),
  heartbeat: (a, b) => compareNullableStrings(a.lastHeartbeatAt, b.lastHeartbeatAt),
};

export function isSortableColumn(columnId: string): boolean {
  return columnId in COLUMN_COMPARATORS;
}

/**
 * The order the table shows before the user touches a header: worst news first.
 *
 * Tier 1 is "affected by a critical/high incident", which the snapshot already carries on
 * `incidents[].affectedAgentIds` — no new plumbing. Tier 2 is STATUS_SORT_PRIORITY (owned by
 * the domain, never redefined here). Tier 3 is most-recent-activity first, so a freshly-failed
 * agent outranks one that failed an hour ago. The final `id` tiebreak keeps the sort total, so
 * two agents with identical timestamps never swap places between renders.
 */
export function compareByDefault(a: Agent, b: Agent, criticalAgentIds: ReadonlySet<AgentId>): number {
  const aCritical = criticalAgentIds.has(a.id) ? 0 : 1;
  const bCritical = criticalAgentIds.has(b.id) ? 0 : 1;

  return (
    aCritical - bCritical ||
    STATUS_SORT_PRIORITY[a.status.kind] - STATUS_SORT_PRIORITY[b.status.kind] ||
    agentActivityAt(b).localeCompare(agentActivityAt(a)) ||
    a.id.localeCompare(b.id)
  );
}

export function compareAgents(
  a: Agent,
  b: Agent,
  sorting: TableSort[],
  criticalAgentIds: ReadonlySet<AgentId>,
): number {
  if (sorting.length === 0) {
    return compareByDefault(a, b, criticalAgentIds);
  }

  for (const sort of sorting) {
    const comparator = COLUMN_COMPARATORS[sort.id];
    if (!comparator) {
      continue;
    }
    const result = comparator(a, b);
    if (result !== 0) {
      return sort.desc ? -result : result;
    }
  }

  return a.id.localeCompare(b.id);
}

export function collectCriticalIncidentAgentIds(incidents: Incident[]): ReadonlySet<AgentId> {
  const agentIds = new Set<AgentId>();
  for (const incident of incidents) {
    if (incident.severity !== "critical" && incident.severity !== "high") {
      continue;
    }
    for (const agentId of incident.affectedAgentIds) {
      agentIds.add(agentId);
    }
  }
  return agentIds;
}

/**
 * The table's row model. Filtering and sorting genuinely have to read every agent, but the
 * *output* is an id array — rows resolve their own `Agent` through `useAgent(id)`, so one
 * agent's update never hands a new object to the other rows.
 */
export function selectVisibleAgentIds(
  snapshot: DashboardSnapshot,
  filters: AgentTableFilters,
  sorting: TableSort[],
): AgentId[] {
  const criticalAgentIds = collectCriticalIncidentAgentIds(snapshot.incidents);
  const matched: Agent[] = [];

  for (const id of snapshot.allIds) {
    const agent = snapshot.byId[id];
    if (agent && matchesFilters(agent, filters)) {
      matched.push(agent);
    }
  }

  matched.sort((a, b) => compareAgents(a, b, sorting, criticalAgentIds));
  return matched.map((agent) => agent.id);
}

/** Filter option lists are derived from what the snapshot actually contains, not a static enum. */
export function deriveBranchOptions(snapshot: DashboardSnapshot): string[] {
  const branches = new Set<string>();
  for (const id of snapshot.allIds) {
    const branch = snapshot.byId[id]?.branch;
    if (branch) {
      branches.add(branch);
    }
  }
  return [...branches].sort((a, b) => a.localeCompare(b));
}
