import { describe, expect, it } from "vitest";
import { EM_DASH, formatCostUsd, formatElapsed, formatRuntimePids, formatTokens } from "./format";

const START = "2026-07-10T00:00:00.000Z";
const startMs = Date.parse(START);

describe("formatElapsed", () => {
  it("shows seconds below a minute rather than rounding down to a misleading 0m", () => {
    expect(formatElapsed(START, startMs + 45_000)).toBe("45s");
    expect(formatElapsed(START, startMs)).toBe("0s");
  });

  it("shows minutes only below an hour", () => {
    expect(formatElapsed(START, startMs + 14 * 60_000 + 30_000)).toBe("14m");
  });

  it("shows two units, largest first, above an hour", () => {
    expect(formatElapsed(START, startMs + 2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatElapsed(START, startMs + 3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });

  it("clamps clock skew to zero instead of rendering a negative age", () => {
    expect(formatElapsed(START, startMs - 60_000)).toBe("0s");
  });

  it("returns an em dash for an unparseable timestamp", () => {
    expect(formatElapsed("not-a-date", startMs)).toBe(EM_DASH);
  });
});

describe("formatCostUsd", () => {
  it("renders an em dash for null — real/local mode has no pricing table", () => {
    expect(formatCostUsd(null)).toBe(EM_DASH);
  });

  it("never renders $0.00 or $NaN for a missing value", () => {
    expect(formatCostUsd(null)).not.toBe("$0.00");
    expect(formatCostUsd(null)).not.toContain("NaN");
  });

  it("formats a real amount as USD currency", () => {
    expect(formatCostUsd(1.234)).toBe("$1.23");
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("groups digits so columns of numbers stay scannable", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatRuntimePids", () => {
  it("renders an em dash when no process was matched", () => {
    expect(formatRuntimePids([])).toBe(EM_DASH);
  });

  it("joins every matched pid", () => {
    expect(formatRuntimePids([123, 456])).toBe("123, 456");
  });
});
