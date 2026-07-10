import { dashboardRepository } from "@/data-access/repositories";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { RealtimeEvent } from "@/domain/realtime/events";
import { guardLocalRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 10_000;

/** WHATWG SSE framing. `event: message` is the default type, so the client reads it via onmessage. */
function formatSse(event: RealtimeEvent): string {
  return `id: ${event.eventId}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Codex's state DB and rollout logs have no push/notify capability, so this endpoint is an honest
 * poll-and-diff bridge, not a real event source: it re-reads the snapshot every POLL_INTERVAL_MS and
 * emits only what changed since the last message on THIS connection.
 *
 * We deliberately keep no server-side event history. Instead, every connection opens with a full
 * resync burst (one agent_upserted per agent, one incident_upserted per incident, one
 * summary_updated), which makes reconnects self-healing without replaying missed events.
 * `sequence` is only monotonic within a single connection — that is all a client needs to detect a
 * gap, because there is no cross-connection history to reconcile.
 *
 * The burst starts at sequence 0 and increments like any other event rather than sharing a single
 * sequence/eventId across the whole burst: a shared id makes every message after the first look
 * like a duplicate, and a shared sequence makes them look out-of-order, so a client-side ordering
 * guard would discard the very resync it depends on. The client adopts the first sequence it sees
 * on a fresh connection, so a monotonic burst costs nothing and keeps eventId genuinely unique.
 */
export async function GET(request: Request) {
  const denied = guardLocalRequest(request);
  if (denied) {
    return denied;
  }

  const encoder = new TextEncoder();
  let cleanup = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let sequence = 0;
      let ticking = false;
      let lastSentAt = Date.now();
      /** Declared before cleanup(): an abort can fire during the initial await, before the interval exists. */
      let timer: ReturnType<typeof setInterval> | undefined;

      const agentFingerprints = new Map<string, string>();
      const incidentFingerprints = new Map<string, string>();
      let summaryFingerprint: string | null = null;

      const send = (event: RealtimeEvent): void => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(formatSse(event)));
          lastSentAt = Date.now();
        } catch {
          // 클라이언트가 이미 끊긴 경우: 다음 tick에서 정리된다.
        }
      };

      /** Strictly monotonic and unique for the connection's lifetime, starting at 0. */
      const meta = () => {
        const seq = sequence;
        sequence += 1;
        return {
          eventId: String(seq),
          sequence: seq,
          timestamp: new Date().toISOString(),
          correlationId: null,
        };
      };

      const syncSnapshot = (snapshot: DashboardSnapshot): void => {
        for (const id of snapshot.allIds) {
          const agent = snapshot.byId[id];
          if (!agent) {
            continue;
          }

          const fingerprint = JSON.stringify(agent);
          if (agentFingerprints.get(id) !== fingerprint) {
            agentFingerprints.set(id, fingerprint);
            send({ ...meta(), type: "agent_upserted", entityId: id, payload: agent });
          }
        }

        const currentAgentIds = new Set(snapshot.allIds);
        for (const id of [...agentFingerprints.keys()]) {
          if (!currentAgentIds.has(id)) {
            agentFingerprints.delete(id);
            send({
              ...meta(),
              type: "agent_removed",
              entityId: id,
              payload: { reason: "스냅샷에서 더 이상 관측되지 않습니다." },
            });
          }
        }

        for (const incident of snapshot.incidents) {
          const fingerprint = JSON.stringify(incident);
          if (incidentFingerprints.get(incident.id) !== fingerprint) {
            incidentFingerprints.set(incident.id, fingerprint);
            send({ ...meta(), type: "incident_upserted", entityId: incident.id, payload: incident });
          }
        }

        const currentIncidentIds = new Set(snapshot.incidents.map((incident) => incident.id));
        for (const id of [...incidentFingerprints.keys()]) {
          if (!currentIncidentIds.has(id)) {
            incidentFingerprints.delete(id);
            send({ ...meta(), type: "incident_resolved", entityId: id, payload: {} });
          }
        }

        const nextSummaryFingerprint = JSON.stringify(snapshot.summary);
        if (summaryFingerprint !== nextSummaryFingerprint) {
          summaryFingerprint = nextSummaryFingerprint;
          send({ ...meta(), type: "summary_updated", entityId: null, payload: snapshot.summary });
        }
      };

      const tick = async (): Promise<void> => {
        if (closed || ticking) {
          return;
        }

        ticking = true;
        try {
          const snapshot = await dashboardRepository.getSnapshot();
          if (closed) {
            return;
          }

          syncSnapshot(snapshot);

          if (!closed && Date.now() - lastSentAt >= HEARTBEAT_INTERVAL_MS) {
            send({
              ...meta(),
              type: "heartbeat",
              entityId: null,
              payload: { serverTime: new Date().toISOString() },
            });
          }
        } catch {
          // 스냅샷 실패로 연결을 끊지 않는다. 다음 tick에서 다시 시도한다.
        } finally {
          ticking = false;
        }
      };

      cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (timer !== undefined) {
          clearInterval(timer);
        }
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // 이미 닫힌 스트림은 무시한다.
        }
      };

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup);

      try {
        /** Fingerprint maps are empty here, so this first sync naturally emits the full resync burst. */
        const snapshot = await dashboardRepository.getSnapshot();
        syncSnapshot(snapshot);
      } catch {
        // 첫 스냅샷이 실패해도 연결은 유지하고 폴링 루프가 복구를 시도한다.
      }

      /** The client may have disconnected during the initial snapshot read. */
      if (closed) {
        return;
      }

      timer = setInterval(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
