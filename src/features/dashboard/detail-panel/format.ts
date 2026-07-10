import type { AgentStatus } from "@/domain/agent/status";

/** Rendered wherever the domain genuinely has no value, rather than a fabricated zero. */
export const EMPTY_VALUE = "—";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact elapsed time, two units at most ("2일 3시간", "1시간 24분", "12초").
 *
 * Hand-rolled rather than `Intl.DurationFormat`: it exists in Node 24 but is absent from the
 * ES2022 lib types this project compiles against, and browser support is still uneven — neither
 * an `as any` cast nor a date library is worth a string this small.
 */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const startedMs = Date.parse(fromIso);
  if (Number.isNaN(startedMs)) {
    return EMPTY_VALUE;
  }

  const elapsedMs = Math.max(0, nowMs - startedMs);
  if (elapsedMs < MINUTE_MS) {
    return `${Math.floor(elapsedMs / 1000)}초`;
  }

  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}분`;
  }

  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`;
  }

  const days = Math.floor(elapsedMs / DAY_MS);
  const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}일` : `${days}일 ${hours}시간`;
}

export function formatTokens(tokensUsed: number): string {
  return tokensUsed.toLocaleString("ko-KR");
}

/** Always `—` in real/local mode: Codex's state DB carries no pricing data (see local-adapter.ts). */
export function formatCost(costUsd: number | null): string {
  return costUsd === null ? EMPTY_VALUE : `$${costUsd.toFixed(2)}`;
}

export const SHORT_SHA_LENGTH = 8;

export function shortCommitSha(commitSha: string | null): string | null {
  return commitSha === null ? null : commitSha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * The status union carries a different timestamp field per variant, and `offline` may carry none at
 * all. Reading `agent.lastHeartbeatAt` instead would report a heartbeat for states that never had one.
 */
export function statusTimestamp(status: AgentStatus): string | null {
  if (status.kind === "running" || status.kind === "stale") {
    return status.lastHeartbeatAt;
  }
  if (status.kind === "waiting" || status.kind === "blocked") {
    return status.since;
  }
  if (status.kind === "approval_required") {
    return status.requestedAt;
  }
  if (status.kind === "failed") {
    return status.failedAt;
  }
  if (status.kind === "completed") {
    return status.completedAt;
  }
  if (status.kind === "paused") {
    return status.pausedAt;
  }
  return status.lastSeenAt;
}

/** Only the `failed` variant records retries; every other state must render nothing, not a zero. */
export function retryCount(status: AgentStatus): number | null {
  return status.kind === "failed" ? status.retryCount : null;
}

/** The failure reason (`failed`) or the blocker (`blocked`); null everywhere else. */
export function statusReason(status: AgentStatus): string | null {
  if (status.kind === "failed") {
    return status.error;
  }
  if (status.kind === "blocked") {
    return status.blocker;
  }
  return null;
}
