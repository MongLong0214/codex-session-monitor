import type { DashboardSnapshot } from "@/domain/dashboard";

/**
 * Read side of the dashboard. Implemented by local-adapter (real Codex state DB) and
 * mock-adapter (deterministic fixtures). Callers never construct a snapshot themselves.
 */
export interface DashboardRepository {
  getSnapshot(): Promise<DashboardSnapshot>;
}
