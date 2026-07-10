import type { RealtimeEvent } from "@/domain/realtime/events";

export type EventDecision = "apply" | "duplicate" | "out_of_order" | "gap";

export interface EventClassification {
  decision: EventDecision;
  /** Count of events presumed lost. Only ever non-zero for `gap`. */
  missing: number;
}

/** Bounds the dedup window; a burst is one event per agent, so this is generous for a local tool. */
const DEFAULT_SEEN_CAPACITY = 512;

/**
 * Per-connection ordering guard. Deterministic and free of React/DOM/network, so the decision
 * table can be exercised directly in unit tests.
 *
 * `reset()` on every fresh connection is load-bearing: the server restarts `sequence` at a low
 * number per connection and replays a full resync burst, so a counter carried across a reconnect
 * would classify that entire burst as stale and silently discard the authoritative state.
 *
 * After a reset the first event's sequence is *adopted* rather than compared against 0 — a fresh
 * connection has nothing it could have missed, and hard-coding an expected origin of 0 would emit
 * a spurious gap (and a spurious refetch) on every connect if the server ever starts at 1.
 */
export class EventSequencer {
  readonly #capacity: number;
  #expected: number | null = null;
  #seen = new Set<string>();
  #order: string[] = [];

  constructor(capacity: number = DEFAULT_SEEN_CAPACITY) {
    this.#capacity = capacity;
  }

  reset(): void {
    this.#expected = null;
    this.#seen.clear();
    this.#order = [];
  }

  classify(event: RealtimeEvent): EventClassification {
    if (this.#seen.has(event.eventId)) {
      return { decision: "duplicate", missing: 0 };
    }

    if (this.#expected === null) {
      this.#remember(event.eventId);
      this.#expected = event.sequence + 1;
      return { decision: "apply", missing: 0 };
    }

    // A lower sequence is older state than what we already merged; applying it would move the
    // cache backwards. Drop it without advancing the counter.
    if (event.sequence < this.#expected) {
      return { decision: "out_of_order", missing: 0 };
    }

    const missing = event.sequence - this.#expected;
    this.#remember(event.eventId);
    this.#expected = event.sequence + 1;

    return missing > 0 ? { decision: "gap", missing } : { decision: "apply", missing: 0 };
  }

  #remember(eventId: string): void {
    this.#seen.add(eventId);
    this.#order.push(eventId);
    if (this.#order.length > this.#capacity) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
  }
}
