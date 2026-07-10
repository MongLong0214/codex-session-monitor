import { describe, expect, it } from "vitest";
import { logLinesFromTail } from "./local-agent-logs";

/** Shapes copied from real rollout JSONL lines on this machine, not invented. */
function rolloutLine(entry: unknown): string {
  return JSON.stringify(entry);
}

const AGENT_MESSAGE = rolloutLine({
  timestamp: "2026-07-10T07:47:46.378Z",
  type: "event_msg",
  payload: { type: "agent_message", message: "테스트를 실행합니다" },
});

const TOOL_CALL = rolloutLine({
  timestamp: "2026-07-10T07:48:26.526Z",
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec" },
});

const TASK_COMPLETE = rolloutLine({
  timestamp: "2026-07-10T07:49:00.000Z",
  type: "event_msg",
  payload: { type: "task_complete" },
});

/** describeRolloutEvent has no text for these, so they must not become log rows. */
const REASONING = rolloutLine({
  timestamp: "2026-07-10T07:48:00.000Z",
  type: "response_item",
  payload: { type: "reasoning" },
});

const TOKEN_COUNT = rolloutLine({
  timestamp: "2026-07-10T07:48:10.000Z",
  type: "event_msg",
  payload: { type: "token_count" },
});

describe("logLinesFromTail", () => {
  it("keeps chronological order and maps events through describeRolloutEvent", () => {
    const { lines, droppedCount } = logLinesFromTail([AGENT_MESSAGE, TOOL_CALL, TASK_COMPLETE].join("\n"), 500);

    expect(droppedCount).toBe(0);
    expect(lines.map((line) => line.text)).toEqual(["테스트를 실행합니다", "도구 실행: exec", "작업 완료 신호"]);
    expect(lines[0]?.timestamp).toBe("2026-07-10T07:47:46.378Z");
  });

  it("labels every line 'info' — the rollout vocabulary carries no severity", () => {
    const { lines } = logLinesFromTail([AGENT_MESSAGE, TOOL_CALL].join("\n"), 500);
    expect(lines.every((line) => line.level === "info")).toBe(true);
  });

  it("omits entries the describer has no text for instead of dumping raw JSON", () => {
    const { lines } = logLinesFromTail([REASONING, AGENT_MESSAGE, TOKEN_COUNT].join("\n"), 500);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("테스트를 실행합니다");
  });

  it("skips the truncated leading record and non-JSON noise without throwing", () => {
    const { lines } = logLinesFromTail(['{"type":"event_msg","paylo', "", AGENT_MESSAGE].join("\n"), 500);
    expect(lines).toHaveLength(1);
  });

  it("keeps the newest lines when the limit is exceeded and reports the drop", () => {
    const { lines, droppedCount } = logLinesFromTail([AGENT_MESSAGE, TOOL_CALL, TASK_COMPLETE].join("\n"), 2);

    expect(droppedCount).toBe(1);
    expect(lines.map((line) => line.text)).toEqual(["도구 실행: exec", "작업 완료 신호"]);
  });

  it("gives colliding timestamps distinct ids so the list never reuses a key", () => {
    const duplicate = rolloutLine({
      timestamp: "2026-07-10T07:47:46.378Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "두 번째" },
    });

    const { lines } = logLinesFromTail([AGENT_MESSAGE, duplicate].join("\n"), 500);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
  });

  it("returns nothing for an empty tail", () => {
    expect(logLinesFromTail("", 500)).toEqual({ lines: [], droppedCount: 0 });
  });
});
