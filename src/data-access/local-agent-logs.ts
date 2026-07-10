import { stat } from "node:fs/promises";

import type { AgentLogLine, AgentLogsResponse, LocalAgentLogLevel } from "@/domain/agent/logs";

import type { AgentLogRepository } from "./agent-log-repository";
import { logLinesFromClaudeCodeTail } from "./claude-code-logs";
import { TAIL_BYTES, describeRolloutEvent, localDashboardRepository, readTail } from "./local-adapter";

/**
 * Every line the local reader emits is "info": the rollout vocabulary has no severity marker, and a
 * keyword-guessing classifier would produce authoritative-looking false positives. See domain/agent/logs.ts.
 */
const LOCAL_LOG_LEVEL: LocalAgentLogLevel = "info";

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Ids stay stable while the tail window slides (a plain line ordinal would shift every poll and
 * remount every row), so they key off the timestamp plus its occurrence count at that instant.
 */
function nextId(timestamp: string | null, seenAt: Map<string, number>): string {
  const bucket = timestamp ?? "unknown";
  const occurrence = seenAt.get(bucket) ?? 0;
  seenAt.set(bucket, occurrence + 1);
  return `${bucket}#${occurrence}`;
}

export interface TailLogLines {
  lines: AgentLogLine[];
  /** Parseable activity lines that existed in the tail but fell outside the requested limit. */
  droppedCount: number;
}

/**
 * Interprets a rollout JSONL tail through the same `describeRolloutEvent` the snapshot builder uses,
 * so a log row and the agent's `currentTask` can never disagree about what an event means. Entries
 * the describer has no text for (reasoning, token_count, tool output) yield no line — that omission
 * is the honest answer, not a gap to paper over with raw JSON dumps.
 */
export function logLinesFromTail(tail: string, limit: number): TailLogLines {
  const activities: { timestamp: string | null; text: string }[] = [];

  for (const line of tail.split("\n")) {
    if (!line) {
      continue;
    }

    let entry: Record<string, unknown> | null;
    try {
      entry = toRecord(JSON.parse(line));
    } catch {
      // 잘린 첫 줄과 비 JSON 줄은 무시한다.
      continue;
    }

    if (!entry) {
      continue;
    }

    const activity = describeRolloutEvent(entry);
    if (!activity?.text) {
      continue;
    }

    activities.push({
      timestamp: activity.timestamp === null ? null : new Date(activity.timestamp).toISOString(),
      text: activity.text,
    });
  }

  const kept = activities.slice(-limit);
  const seenAt = new Map<string, number>();

  return {
    lines: kept.map((activity) => ({
      id: nextId(activity.timestamp, seenAt),
      timestamp: activity.timestamp,
      level: LOCAL_LOG_LEVEL,
      text: activity.text,
    })),
    droppedCount: activities.length - kept.length,
  };
}

async function exceedsTailWindow(rolloutPath: string): Promise<boolean> {
  try {
    const fileStat = await stat(rolloutPath);
    return fileStat.size > TAIL_BYTES;
  } catch {
    return false;
  }
}

/** Registered-agent allowlist plus snapshot-owned path: the caller never names a file. */
async function readLines(agentId: string, limit: number): Promise<AgentLogsResponse> {
  const snapshot = await localDashboardRepository.getSnapshot();
  const agent = snapshot.byId[agentId];
  if (!agent?.rolloutPath) {
    return { agentId, lines: [], isTruncated: false };
  }

  const [tail, isWindowExceeded] = await Promise.all([
    readTail(agent.rolloutPath),
    exceedsTailWindow(agent.rolloutPath),
  ]);
  /**
   * Same file-tail read, different event vocabulary: Codex rollout JSONL and Claude Code session
   * JSONL share nothing but the "one JSON object per line" shape, so the two sources need their own
   * line interpreters. Dispatching here — rather than in each interpreter — keeps both interpreters
   * ignorant of the other source, matching how local-adapter.ts and claude-code-adapter.ts never
   * import from each other.
   */
  const { lines, droppedCount } =
    agent.source === "claude_code" ? logLinesFromClaudeCodeTail(tail, limit) : logLinesFromTail(tail, limit);

  return { agentId, lines, isTruncated: isWindowExceeded || droppedCount > 0 };
}

export const localAgentLogRepository: AgentLogRepository = { readLines };
