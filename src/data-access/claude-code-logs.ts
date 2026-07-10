import type { AgentLogLine, LocalAgentLogLevel } from "@/domain/agent/logs";

import { asString, isoToMs, textFromLine, toRecord } from "./claude-code-adapter";
import type { TailLogLines } from "./local-agent-logs";

/**
 * Same honesty constraint as the Codex reader (see local-agent-logs.ts): Claude Code's own JSONL
 * vocabulary (user/assistant/system/ai-title/...) carries no severity field either, so every line
 * this reader produces is "info" — never a guessed error/warning classification.
 */
const CLAUDE_LOG_LEVEL: LocalAgentLogLevel = "info";

function nextId(timestamp: string | null, seenAt: Map<string, number>): string {
  const bucket = timestamp ?? "unknown";
  const occurrence = seenAt.get(bucket) ?? 0;
  seenAt.set(bucket, occurrence + 1);
  return `${bucket}#${occurrence}`;
}

/**
 * Interprets a Claude Code session JSONL tail through the same `textFromLine` the snapshot builder
 * uses for `currentTask`, so a log row and the agent's current-task summary can never disagree.
 * Lines with no human-meaningful text (reasoning blocks, tool_result payloads, bookkeeping events
 * like `mode`/`permission-mode`) yield no line — the same "omission over a raw JSON dump" choice
 * the Codex reader makes.
 */
export function logLinesFromClaudeCodeTail(tail: string, limit: number): TailLogLines {
  const activities: { timestamp: string | null; text: string }[] = [];

  for (const line of tail.split("\n")) {
    if (!line) {
      continue;
    }

    let entry: Record<string, unknown> | null;
    try {
      entry = toRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) {
      continue;
    }

    const type = asString(entry.type);
    if (!type) {
      continue;
    }

    const message = toRecord(entry.message);
    const text = textFromLine(type, message, message?.content);
    if (!text) {
      continue;
    }

    const timestampMs = isoToMs(entry.timestamp);
    activities.push({
      timestamp: timestampMs === null ? null : new Date(timestampMs).toISOString(),
      text,
    });
  }

  const kept = activities.slice(-limit);
  const seenAt = new Map<string, number>();

  return {
    lines: kept.map((activity) => ({
      id: nextId(activity.timestamp, seenAt),
      timestamp: activity.timestamp,
      level: CLAUDE_LOG_LEVEL,
      text: activity.text,
    })) satisfies AgentLogLine[],
    droppedCount: activities.length - kept.length,
  };
}
