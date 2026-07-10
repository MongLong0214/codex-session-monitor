import { useQuery } from "@tanstack/react-query";
import { fetchDashboardSnapshot } from "./api";
import { dashboardKeys } from "./keys";

export function useDashboardSnapshot() {
  return useQuery({
    queryKey: dashboardKeys.snapshot(),
    queryFn: ({ signal }) => fetchDashboardSnapshot(signal),
  });
}
