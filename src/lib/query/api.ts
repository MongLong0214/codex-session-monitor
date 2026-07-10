import {
  AgentActionResultSchema,
  BulkAgentActionResponseSchema,
  type AgentActionRequest,
  type AgentActionResult,
  type BulkAgentActionRequest,
  type BulkAgentActionResponse,
} from "@/domain/agent/actions";
import type { AgentId } from "@/domain/agent/agent";
import { AgentLogsResponseSchema, type AgentLogsResponse } from "@/domain/agent/logs";
import { DashboardSnapshotSchema, type DashboardSnapshot } from "@/domain/dashboard";

/** Same-origin local app — no base URL indirection to configure. */
export const DASHBOARD_SNAPSHOT_ENDPOINT = "/api/dashboard/snapshot";
export const DASHBOARD_EVENTS_ENDPOINT = "/api/dashboard/events";

interface JsonRequestInit {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * exactOptionalPropertyTypes forbids handing `signal: undefined` to fetch, so optional
 * members are attached only when present rather than spread in unconditionally.
 */
async function requestJson(path: string, init?: JsonRequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const hasBody = init?.body !== undefined;

  const requestInit: RequestInit = {
    method,
    headers: hasBody
      ? { Accept: "application/json", "Content-Type": "application/json" }
      : { Accept: "application/json" },
  };
  if (hasBody) {
    requestInit.body = JSON.stringify(init?.body);
  }
  if (init?.signal) {
    requestInit.signal = init.signal;
  }

  const response = await fetch(path, requestInit);
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return response.json();
}

/**
 * Every response is Zod-parsed rather than type-asserted: the snapshot feeds a normalized
 * cache that the reducer then mutates by reference, so a malformed field would corrupt state
 * far away from its origin.
 */
export async function fetchDashboardSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
  const json = await requestJson(DASHBOARD_SNAPSHOT_ENDPOINT, signal ? { signal } : undefined);
  return DashboardSnapshotSchema.parse(json);
}

export async function fetchAgentLogs(agentId: AgentId, limit: number, signal?: AbortSignal): Promise<AgentLogsResponse> {
  const path = `/api/agents/${encodeURIComponent(agentId)}/logs?limit=${limit}`;
  const json = await requestJson(path, signal ? { signal } : undefined);
  return AgentLogsResponseSchema.parse(json);
}

export async function postAgentAction(agentId: AgentId, request: AgentActionRequest): Promise<AgentActionResult> {
  const json = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/actions`, {
    method: "POST",
    body: request,
  });
  return AgentActionResultSchema.parse(json);
}

export async function postBulkAgentAction(request: BulkAgentActionRequest): Promise<BulkAgentActionResponse> {
  const json = await requestJson("/api/agents/bulk-actions", { method: "POST", body: request });
  return BulkAgentActionResponseSchema.parse(json);
}
