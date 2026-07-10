import { RealtimeEventSchema, type RealtimeEventType } from "@/domain/realtime/events";
import { DASHBOARD_EVENTS_ENDPOINT } from "@/lib/query/api";
import type { RealtimeDisconnect, RealtimeTransport, RealtimeTransportHandlers } from "./transport";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 22_000;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const BACKOFF_JITTER_RATIO = 0.25;

/**
 * The server may or may not set an SSE `event:` field. A named message never reaches
 * `onmessage`, so both paths are wired; they cannot double-fire for the same message.
 */
const NAMED_SSE_EVENTS = [
  "agent_upserted",
  "agent_removed",
  "summary_updated",
  "incident_upserted",
  "incident_resolved",
  "heartbeat",
] as const satisfies readonly RealtimeEventType[];

export interface SseRealtimeTransportOptions {
  url?: string;
  /** A half-dead connection can stay `open` forever without firing `onerror`; heartbeats bound that. */
  heartbeatTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class SseRealtimeTransport implements RealtimeTransport {
  readonly #url: string;
  readonly #heartbeatTimeoutMs: number;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;

  constructor(options: SseRealtimeTransportOptions = {}) {
    this.#url = options.url ?? DASHBOARD_EVENTS_ENDPOINT;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  /**
   * All mutable state lives inside this call, not on the instance, so a transport can be
   * connected again after cleanup (React StrictMode remounts effects) without leaking the
   * previous connection's timers.
   *
   * Sequence ordering is deliberately NOT handled here: dedup / out-of-order / gap detection
   * decide whether the *cache* must resync, which is a concern of the consumer that owns the
   * cache, not of the wire. See EventSequencer.
   */
  connect(handlers: RealtimeTransportHandlers): RealtimeDisconnect {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disconnected = false;
    let warnedInvalidPayload = false;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearStaleTimer = () => {
      if (staleTimer !== null) {
        clearTimeout(staleTimer);
        staleTimer = null;
      }
    };

    const teardownSource = () => {
      if (source === null) {
        return;
      }
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
      source = null;
    };

    const armStaleTimer = () => {
      clearStaleTimer();
      staleTimer = setTimeout(handleStale, this.#heartbeatTimeoutMs);
    };

    const handleMessage = (data: string) => {
      if (disconnected) {
        return;
      }
      // Any inbound byte proves liveness, including payloads we end up dropping.
      armStaleTimer();

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        warnInvalidPayload();
        return;
      }

      const result = RealtimeEventSchema.safeParse(parsed);
      if (!result.success) {
        warnInvalidPayload();
        return;
      }

      handlers.onEvent(result.data);
    };

    const warnInvalidPayload = () => {
      if (warnedInvalidPayload) {
        return;
      }
      warnedInvalidPayload = true;
      console.warn("[sse-transport] dropped an event that failed RealtimeEventSchema validation (logged once).");
    };

    const handleStale = () => {
      if (disconnected) {
        return;
      }
      handlers.onStatusChange("stale");
      teardownSource();
      scheduleReconnect();
    };

    const scheduleReconnect = () => {
      if (disconnected) {
        return;
      }
      clearStaleTimer();
      clearReconnectTimer();
      handlers.onStatusChange("reconnecting");

      const backoff = Math.min(this.#initialBackoffMs * 2 ** attempt, this.#maxBackoffMs);
      const delay = backoff + Math.random() * backoff * BACKOFF_JITTER_RATIO;
      attempt += 1;
      reconnectTimer = setTimeout(open, delay);
    };

    const open = () => {
      if (disconnected) {
        return;
      }
      clearReconnectTimer();
      teardownSource();

      if (typeof EventSource === "undefined") {
        handlers.onStatusChange("closed");
        return;
      }

      const next = new EventSource(this.#url);
      source = next;

      next.onopen = () => {
        if (disconnected) {
          return;
        }
        attempt = 0;
        handlers.onStatusChange("open");
        armStaleTimer();
      };

      next.onmessage = (event: MessageEvent<string>) => {
        handleMessage(event.data);
      };

      for (const name of NAMED_SSE_EVENTS) {
        next.addEventListener(name, (event) => {
          handleMessage((event as MessageEvent<string>).data);
        });
      }

      // Native EventSource retry is bypassed on purpose: closing here hands reconnection
      // (and its backoff) to us, so a stale teardown and an error teardown behave alike.
      next.onerror = () => {
        if (disconnected) {
          return;
        }
        teardownSource();
        scheduleReconnect();
      };
    };

    handlers.onStatusChange("connecting");
    open();

    return () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      clearReconnectTimer();
      clearStaleTimer();
      teardownSource();
      handlers.onStatusChange("closed");
    };
  }
}
