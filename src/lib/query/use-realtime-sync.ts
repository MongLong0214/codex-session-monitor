import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { RealtimeEvent } from "@/domain/realtime/events";
import { EventSequencer } from "@/lib/realtime/event-sequencer";
import { SseRealtimeTransport } from "@/lib/realtime/sse-transport";
import type { ConnectionStatus, RealtimeTransport } from "@/lib/realtime/transport";
import { dashboardKeys } from "./keys";
import { applyRealtimeEvents } from "./reducer";
import { useDashboardSnapshot } from "./use-dashboard-snapshot";

/**
 * setTimeout, not requestAnimationFrame: rAF is paused in background tabs, so a backgrounded
 * dashboard would buffer a reconnect's resync burst indefinitely instead of draining it.
 */
const FLUSH_WINDOW_MS = 32;

export interface RealtimeSyncState {
  status: ConnectionStatus;
  /** Server timestamp of the most recent inbound message, heartbeats included — the liveness clock. */
  lastEventAt: string | null;
}

/**
 * Mount once, beneath QueryProvider. Connection is gated on the snapshot query having landed,
 * so the resync burst never races an in-flight initial fetch; the `prev ? ... : prev` guard in
 * the flush keeps that safe even if the cache is evicted mid-stream.
 *
 * Cache coherence has two recovery paths, both landing on the snapshot endpoint as the authority:
 *   - reconnect: the resync burst is upserts only, so it cannot express agents deleted while we
 *     were disconnected. Refetch, then let the burst apply on top.
 *   - sequence gap: events were lost, so an unknown number of upserts/removals never arrived.
 *     Apply the event we did get (it is newer state) and refetch to reconcile the rest.
 * Duplicates and out-of-order events are dropped outright — never merged.
 *
 * `transport` is captured once per mount rather than defaulted per render — a fresh
 * `new SseRealtimeTransport()` on every render would change the effect's identity and
 * reconnect in a loop. Pass a fake here to test without a network.
 */
export function useRealtimeSync(transport?: RealtimeTransport): RealtimeSyncState {
  const queryClient = useQueryClient();
  const [resolvedTransport] = useState<RealtimeTransport>(() => transport ?? new SseRealtimeTransport());
  const [sequencer] = useState(() => new EventSequencer());

  // Reads `isSuccess` only: tracked-props gating means snapshot data churn never re-renders this hook.
  const { isSuccess } = useDashboardSnapshot();

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const bufferRef = useRef<RealtimeEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    if (!isSuccess) {
      return;
    }

    const flush = () => {
      flushTimerRef.current = null;
      const batch = bufferRef.current;
      if (batch.length === 0) {
        return;
      }
      bufferRef.current = [];

      queryClient.setQueryData<DashboardSnapshot>(dashboardKeys.snapshot(), (prev) =>
        prev ? applyRealtimeEvents(prev, batch) : prev,
      );

      const latest = batch[batch.length - 1];
      if (latest) {
        setLastEventAt(latest.timestamp);
      }
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current !== null) {
        return;
      }
      flushTimerRef.current = setTimeout(flush, FLUSH_WINDOW_MS);
    };

    const resyncFromSnapshot = () => {
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.snapshot() });
    };

    const disconnect = resolvedTransport.connect({
      onEvent: (event) => {
        const { decision, missing } = sequencer.classify(event);

        if (decision === "duplicate" || decision === "out_of_order") {
          return;
        }
        if (decision === "gap") {
          console.warn(`[realtime-sync] sequence gap: ${missing} event(s) lost, refetching snapshot.`);
          resyncFromSnapshot();
        }

        // Heartbeats carry no cache payload; they only advance the liveness clock, and
        // buffering them would churn `revision` for nothing. They still participate in
        // sequencing above, so a gap observed on a heartbeat also triggers a resync.
        if (event.type === "heartbeat") {
          setLastEventAt(event.timestamp);
          return;
        }
        bufferRef.current.push(event);
        scheduleFlush();
      },
      onStatusChange: (next) => {
        setStatus(next);

        if (next === "open") {
          // The server restarts sequences per connection; carrying the counter across would
          // classify the entire resync burst as stale and discard it.
          sequencer.reset();

          if (hasConnectedRef.current) {
            resyncFromSnapshot();
          }
          hasConnectedRef.current = true;
        }
      },
    });

    return () => {
      disconnect();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      bufferRef.current = [];
      hasConnectedRef.current = false;
      sequencer.reset();
    };
  }, [isSuccess, queryClient, resolvedTransport, sequencer]);

  return { status, lastEventAt };
}
