/** Rendered wherever a value is genuinely absent — never a fabricated 0, $0.00 or NaN. */
export const EM_DASH = "—";

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * `Intl.DurationFormat` is unavailable on this project's runtime — verified, not assumed:
 * `node -e "console.log('DurationFormat' in Intl)"` prints `false` on Node 24.18.0. Adding a
 * date/duration library is out of scope per spec, so elapsed time gets this local formatter.
 *
 * Two units at most, largest first ("3d 4h", "2h 14m"), so the column stays scannable at a
 * 34px row height. Sub-minute runs show seconds rather than rounding down to a misleading "0m".
 */
export function formatElapsed(startedAtIso: string, nowMs: number): string {
  const startedMs = Date.parse(startedAtIso);
  if (Number.isNaN(startedMs)) {
    return EM_DASH;
  }

  // A clock skew between the Codex process and the browser must not render as a negative age.
  const elapsedMs = Math.max(0, nowMs - startedMs);

  const days = Math.floor(elapsedMs / MS_PER_DAY);
  const hours = Math.floor((elapsedMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((elapsedMs % MS_PER_MINUTE) / MS_PER_SECOND);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

const costFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * `costUsd` is null in real/local mode because Codex's state DB carries no cost figures
 * (see data-access/local-adapter.ts). Null renders as an em dash, never as `$0.00` — a zero
 * would read as "this session was free" rather than "we do not know".
 */
export function formatCostUsd(costUsd: number | null): string {
  if (costUsd === null) {
    return EM_DASH;
  }
  return costFormatter.format(costUsd);
}

const tokenFormatter = new Intl.NumberFormat("en-US");

export function formatTokens(tokensUsed: number): string {
  return tokenFormatter.format(tokensUsed);
}

/** Runtime PIDs are an array; an empty one means no process was matched by `ps`/`lsof`. */
export function formatRuntimePids(runtimePids: number[]): string {
  if (runtimePids.length === 0) {
    return EM_DASH;
  }
  return runtimePids.join(", ");
}
