import { describe, expect, it } from "vitest";

import { classifyClaudeStatus, pickDisplayName, sessionCostUsd, totalTokens } from "./claude-code-adapter";
import { STALE_HEARTBEAT_THRESHOLD_MS } from "./incident-detection";

/** Shape mirrors the adapter's internal ResponseUsage — one deduped Claude API response. */
function usage(overrides: {
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
}) {
  return {
    model: overrides.model,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    ephemeral5mTokens: overrides.ephemeral5mTokens ?? 0,
    ephemeral1hTokens: overrides.ephemeral1hTokens ?? 0,
  };
}

describe("sessionCostUsd", () => {
  it("computes a real cost for a single sonnet-5 response against the sourced rates", () => {
    // 1M input ($2) + 1M output ($10) = $12; nothing cached.
    const cost = sessionCostUsd([
      usage({ model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ]);
    expect(cost).toBe(12);
  });

  it("applies every rate line (base/5m-write/1h-write/cache-read/output) for opus-4-8", () => {
    // input 1M×$5 + 5m 1M×$6.25 + 1h 1M×$10 + read 1M×$0.50 + output 1M×$25 = $46.75.
    const cost = sessionCostUsd([
      usage({
        model: "claude-opus-4-8",
        inputTokens: 1_000_000,
        ephemeral5mTokens: 1_000_000,
        ephemeral1hTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ]);
    expect(cost).toBe(46.75);
  });

  it("sums across multiple known-model responses", () => {
    const cost = sessionCostUsd([
      usage({ model: "claude-sonnet-5", outputTokens: 500_000 }), // $5
      usage({ model: "claude-opus-4-8", outputTokens: 200_000 }), // $5
    ]);
    expect(cost).toBe(10);
  });

  it("returns null when any response used an unpriced model that actually billed tokens", () => {
    const cost = sessionCostUsd([
      usage({ model: "claude-opus-4-8", outputTokens: 1_000_000 }),
      usage({ model: "claude-fable-5", inputTokens: 50_000 }),
    ]);
    expect(cost).toBeNull();
  });

  it("does not go null for a zero-token unpriced response (e.g. <synthetic>)", () => {
    const cost = sessionCostUsd([
      usage({ model: "claude-sonnet-5", outputTokens: 100_000 }), // $1
      usage({ model: "<synthetic>" }), // 0 tokens ⇒ ignored, not fatal
    ]);
    expect(cost).toBe(1);
  });

  it("is $0 for a session with no assistant responses yet", () => {
    expect(sessionCostUsd([])).toBe(0);
  });
});

describe("totalTokens", () => {
  it("sums the four raw usage counters across responses", () => {
    const total = totalTokens([
      usage({ model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40 }),
      usage({ model: "claude-sonnet-5", inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }),
    ]);
    expect(total).toBe(110);
  });

  it("counts tokens even for unpriced models (token count is model-agnostic)", () => {
    expect(totalTokens([usage({ model: "claude-fable-5", inputTokens: 500 })])).toBe(500);
  });
});

describe("pickDisplayName", () => {
  it("prefers the ai-title when present", () => {
    expect(pickDisplayName("멀티 에이전트 대시보드 마이그레이션", "raw first prompt text", false)).toBe(
      "멀티 에이전트 대시보드 마이그레이션",
    );
  });

  it("falls back to the first user prompt when there is no ai-title", () => {
    expect(pickDisplayName(null, "테스트를 추가해 주세요", false)).toBe("테스트를 추가해 주세요");
  });

  it("collapses whitespace and truncates a very long title", () => {
    const long = "제목 ".repeat(200);
    const name = pickDisplayName(long, null, false);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith("…")).toBe(true);
  });

  it("uses a role-appropriate placeholder when nothing is available", () => {
    expect(pickDisplayName(null, null, false)).toBe("이름 없는 메인 세션");
    expect(pickDisplayName(null, null, true)).toBe("이름 없는 서브 에이전트");
  });
});

describe("classifyClaudeStatus", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");

  it("is running within the recent-activity window", () => {
    const status = classifyClaudeStatus(now - 60_000, now);
    expect(status.kind).toBe("running");
  });

  it("is waiting past recent activity but within the idle threshold", () => {
    const status = classifyClaudeStatus(now - 10 * 60_000, now);
    expect(status.kind).toBe("waiting");
  });

  it("is stale past the shared idle threshold", () => {
    const status = classifyClaudeStatus(now - (STALE_HEARTBEAT_THRESHOLD_MS + 60_000), now);
    expect(status.kind).toBe("stale");
    if (status.kind === "stale") {
      expect(Date.parse(status.lastHeartbeatAt)).toBe(now - (STALE_HEARTBEAT_THRESHOLD_MS + 60_000));
    }
  });
});
