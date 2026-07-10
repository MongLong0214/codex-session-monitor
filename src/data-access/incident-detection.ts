import type { Agent, ProjectRef } from "@/domain/agent/agent";
import type { Incident, IncidentSeverity, IncidentType } from "@/domain/incident/incident";

/**
 * Single source of truth for "how long without activity counts as stale". The local adapter
 * imports this for its idle threshold too, so the classifier and the detector can never drift.
 */
export const STALE_HEARTBEAT_THRESHOLD_MS = 30 * 60 * 1000;

export interface IncidentDetectionInput {
  agents: readonly Agent[];
  projects: readonly ProjectRef[];
  now: number;
}

/**
 * "realtime_disconnected" is intentionally absent: it describes the browser's SSE connection
 * state, which the server cannot observe about itself. The client raises it locally.
 */
type DetectableIncidentType = Exclude<IncidentType, "realtime_disconnected">;

type IncidentDetector = (input: IncidentDetectionInput) => Incident[];

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function minutesOf(milliseconds: number): number {
  return Math.round(milliseconds / 60_000);
}

/**
 * The only detector with a real signal today. Both the id and the payload are derived purely from
 * observed values — no wall-clock reads — so an unchanged stale agent produces a byte-identical
 * incident on every poll and the SSE layer emits `incident_upserted` exactly once.
 * `detectedAt` is the moment the threshold was crossed (heartbeat + threshold), not the moment we
 * happened to look, which keeps it stable and independently verifiable from `evidence`.
 */
function detectStaleHeartbeat({ agents }: IncidentDetectionInput): Incident[] {
  const incidents: Incident[] = [];

  for (const agent of agents) {
    if (agent.status.kind !== "stale") {
      continue;
    }

    const heartbeatMs = Date.parse(agent.status.lastHeartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      continue;
    }

    incidents.push({
      id: `stale_heartbeat:${agent.id}`,
      severity: "high",
      type: "stale_heartbeat",
      detectedAt: new Date(heartbeatMs + STALE_HEARTBEAT_THRESHOLD_MS).toISOString(),
      affectedAgentIds: [agent.id],
      affectedProjectIds: [agent.project.cwd],
      summary: `${agent.displayName} 세션이 오랫동안 활동하지 않았습니다.`,
      evidence: `마지막 활동 ${agent.status.lastHeartbeatAt} (임계값 ${minutesOf(STALE_HEARTBEAT_THRESHOLD_MS)}분 초과)`,
      suggestedAction: "터미널을 열어 세션 상태를 확인하고, 응답이 없으면 프로세스를 정지하세요.",
    });
  }

  return incidents;
}

/**
 * Every remaining type is wired in so the framework is complete and exhaustively typed, but each
 * returns nothing until a real signal exists. Verified against the live rollout JSONL vocabulary
 * (task_started, task_complete, agent_message, sub_agent_activity, token_count, patch_apply_end,
 * custom_tool_call*, function_call*, turn_aborted, context_compacted) — nothing else is observable.
 */
const DETECTORS: Record<DetectableIncidentType, IncidentDetector> = {
  stale_heartbeat: detectStaleHeartbeat,

  // Needs a failure signal: Codex emits no error event type, so the local adapter never yields "failed".
  repeated_failure: () => [],

  // Needs a per-task expected-duration baseline; raw uptime alone does not make a run abnormal.
  abnormally_long_run: () => [],

  // Needs a pricing table; the state DB carries tokens but no cost, so costUsd is always null.
  cost_spike: () => [],

  // Needs per-file edit attribution (correlating patch_apply_end paths across agents), not yet parsed.
  concurrent_file_edit: () => [],

  // Needs git worktree / merge-base inspection across agents on the same repo, not yet implemented.
  branch_conflict: () => [],

  // Needs an approval-request signal: Codex emits no approval event type, so no agent is ever "approval_required".
  approval_pending_too_long: () => [],

  // Needs a blocker signal: no event distinguishes a blocked agent from an idle one.
  dependency_blocked: () => [],

  // Needs an error/log-level signal: the rollout vocabulary has no error event type to count.
  log_error_spike: () => [],
};

function compareIncidents(left: Incident, right: Incident): number {
  const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  return bySeverity !== 0 ? bySeverity : left.id.localeCompare(right.id);
}

/** Deterministically ordered (severity, then id) so snapshot fingerprints are stable across polls. */
export function detectIncidents(input: IncidentDetectionInput): Incident[] {
  return Object.values(DETECTORS)
    .flatMap((detect) => detect(input))
    .sort(compareIncidents);
}
