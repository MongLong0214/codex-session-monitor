/**
 * Single cache entry for the whole dashboard: the table, the summary counters and the
 * detail panel all read slices of `snapshot()` via `select`, so realtime writes land in
 * one place and subscribers stay reference-stable.
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  snapshot: () => [...dashboardKeys.all, "snapshot"] as const,
} as const;
