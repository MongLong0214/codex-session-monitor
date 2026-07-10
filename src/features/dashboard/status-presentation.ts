import type { AgentStatusKind } from "@/domain/agent/status";
import type { ConnectionStatus } from "@/lib/realtime/transport";

/**
 * StatusDot only ships 5 semantic variants, so several of our 9 states share a color —
 * they're always paired with STATUS_LABEL text too, never color-only (see StatusDot's own
 * accessibility guidance).
 */
export const STATUS_DOT_VARIANT: Record<AgentStatusKind, "success" | "warning" | "error" | "accent" | "neutral"> = {
  running: "accent",
  waiting: "neutral",
  approval_required: "warning",
  blocked: "warning",
  failed: "error",
  completed: "success",
  paused: "neutral",
  stale: "warning",
  offline: "neutral",
};

export const STATUS_LABEL: Record<AgentStatusKind, string> = {
  running: "실행 중",
  waiting: "대기 중",
  approval_required: "승인 대기",
  blocked: "차단됨",
  failed: "실패",
  completed: "완료",
  paused: "일시정지",
  stale: "응답 없음",
  offline: "오프라인",
};

export const CONNECTION_DOT_VARIANT: Record<ConnectionStatus, "success" | "warning" | "error" | "accent" | "neutral"> =
  {
    connecting: "neutral",
    open: "success",
    reconnecting: "warning",
    stale: "warning",
    closed: "error",
  };

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "연결 중",
  open: "연결됨",
  reconnecting: "재연결 중",
  stale: "응답 지연",
  closed: "연결 끊김",
};
