/**
 * Single cache entry for the whole dashboard: the table, the summary counters and the
 * detail panel all read slices of `snapshot()` via `select`, so realtime writes land in
 * one place and subscribers stay reference-stable.
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  snapshot: () => [...dashboardKeys.all, "snapshot"] as const,
} as const;

/**
 * Deliberately not nested under `dashboardKeys.all`: agent logs come from their own endpoint and
 * must not be swept up by the snapshot invalidation every mutation fires.
 */
export const agentKeys = {
  all: ["agent"] as const,
  logs: (agentId: string, limit: number) => [...agentKeys.all, agentId, "logs", limit] as const,
} as const;
