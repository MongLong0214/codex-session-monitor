import type { Agent } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { RealtimeEvent } from "@/domain/realtime/events";

type EventOf<T extends RealtimeEvent["type"]> = Extract<RealtimeEvent, { type: T }>;

/**
 * Bumps the snapshot's own bookkeeping. Callers pass only the slices that actually changed,
 * so every untouched slice (and every untouched `byId` value) keeps its object identity —
 * that identity is what lets table rows and `allIds` subscribers skip re-rendering.
 */
function commit(
  snapshot: DashboardSnapshot,
  event: RealtimeEvent,
  patch: Partial<DashboardSnapshot>,
): DashboardSnapshot {
  return {
    ...snapshot,
    ...patch,
    revision: snapshot.revision + 1,
    lastSyncedAt: event.timestamp,
  };
}

function applyAgentUpserted(snapshot: DashboardSnapshot, event: EventOf<"agent_upserted">): DashboardSnapshot {
  const { entityId, payload } = event;

  // Only the changed key gets a new value; every other entry keeps its reference.
  const byId: Record<string, Agent> = { ...snapshot.byId, [entityId]: payload };
  const allIds = snapshot.allIds.includes(entityId) ? snapshot.allIds : [...snapshot.allIds, entityId];

  return commit(snapshot, event, { byId, allIds });
}

function applyAgentRemoved(snapshot: DashboardSnapshot, event: EventOf<"agent_removed">): DashboardSnapshot {
  const { entityId } = event;
  const existsInById = Object.hasOwn(snapshot.byId, entityId);
  const existsInAllIds = snapshot.allIds.includes(entityId);

  if (!existsInById && !existsInAllIds) {
    return snapshot;
  }

  let byId = snapshot.byId;
  if (existsInById) {
    byId = { ...snapshot.byId };
    delete byId[entityId];
  }
  const allIds = existsInAllIds ? snapshot.allIds.filter((id) => id !== entityId) : snapshot.allIds;

  return commit(snapshot, event, { byId, allIds });
}

function applySummaryUpdated(snapshot: DashboardSnapshot, event: EventOf<"summary_updated">): DashboardSnapshot {
  return commit(snapshot, event, { summary: event.payload });
}

function applyIncidentUpserted(snapshot: DashboardSnapshot, event: EventOf<"incident_upserted">): DashboardSnapshot {
  const index = snapshot.incidents.findIndex((incident) => incident.id === event.entityId);
  const incidents =
    index === -1
      ? [...snapshot.incidents, event.payload]
      : snapshot.incidents.map((incident, i) => (i === index ? event.payload : incident));

  return commit(snapshot, event, { incidents });
}

function applyIncidentResolved(snapshot: DashboardSnapshot, event: EventOf<"incident_resolved">): DashboardSnapshot {
  if (!snapshot.incidents.some((incident) => incident.id === event.entityId)) {
    return snapshot;
  }
  const incidents = snapshot.incidents.filter((incident) => incident.id !== event.entityId);

  return commit(snapshot, event, { incidents });
}

/**
 * Pure, React-free normalized-cache reducer.
 *
 * Reference invariant: an event that does not touch a given agent leaves that agent's object
 * in `byId` identical (`===`) to the input's, and leaves `allIds` as the very same array when
 * the id set is unchanged. `heartbeat` is a transport-level liveness signal with no cache
 * payload, so it returns the snapshot itself.
 *
 * `projects` is intentionally never derived here: the event contract has no project event, and
 * the server owns that aggregate (as it does `summary`, which is why `summary_updated` exists).
 * Inventing a client-side projects list would silently diverge until the next refetch papered
 * over it. Reconnects invalidate the snapshot query, which is where `projects` is reconciled.
 */
export function applyRealtimeEvent(snapshot: DashboardSnapshot, event: RealtimeEvent): DashboardSnapshot {
  switch (event.type) {
    case "agent_upserted":
      return applyAgentUpserted(snapshot, event);
    case "agent_removed":
      return applyAgentRemoved(snapshot, event);
    case "summary_updated":
      return applySummaryUpdated(snapshot, event);
    case "incident_upserted":
      return applyIncidentUpserted(snapshot, event);
    case "incident_resolved":
      return applyIncidentResolved(snapshot, event);
    case "heartbeat":
      return snapshot;
  }
}

export function applyRealtimeEvents(snapshot: DashboardSnapshot, events: RealtimeEvent[]): DashboardSnapshot {
  return events.reduce<DashboardSnapshot>((acc, event) => applyRealtimeEvent(acc, event), snapshot);
}
