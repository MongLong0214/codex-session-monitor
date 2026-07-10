import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AgentId } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import { fetchDashboardSnapshot } from "./api";
import { dashboardKeys } from "./keys";

/**
 * Rides the snapshot's cache entry — same query key, so no extra request — and narrows to one
 * agent. Verified against @tanstack/query-core 5.101.2: the `select` result is passed through
 * `replaceData`/`replaceEqualDeep`, which returns the previous value on `===`, and the default
 * tracked-props gating only notifies when a property the component actually read has changed.
 * So while an unrelated agent's update does re-run `select`, it yields the identical `Agent`
 * reference and this hook's consumers do not re-render. The stable `select` (useCallback) also
 * hits the observer's memoized fast path, skipping the re-run entirely.
 *
 * Returns `undefined` when the id is unknown (removed agent, stale deep link).
 */
export function useAgent(agentId: AgentId) {
  const select = useCallback((snapshot: DashboardSnapshot) => snapshot.byId[agentId], [agentId]);

  return useQuery({
    queryKey: dashboardKeys.snapshot(),
    queryFn: ({ signal }) => fetchDashboardSnapshot(signal),
    select,
  });
}
