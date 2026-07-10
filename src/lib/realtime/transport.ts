import type { RealtimeEvent } from "@/domain/realtime/events";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "stale" | "closed";

export interface RealtimeTransportHandlers {
  onEvent: (event: RealtimeEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

/** Idempotent: safe to call more than once. */
export type RealtimeDisconnect = () => void;

/**
 * The seam that keeps SSE swappable for WebSocket later — deliberately free of any
 * EventSource-specific type, so consumers never learn which wire protocol is in use.
 */
export interface RealtimeTransport {
  connect(handlers: RealtimeTransportHandlers): RealtimeDisconnect;
}
