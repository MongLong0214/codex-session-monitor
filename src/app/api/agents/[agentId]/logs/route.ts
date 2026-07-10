import { NextResponse } from "next/server";

import { agentLogRepository, dashboardRepository } from "@/data-access/repositories";
import { AgentLogQuerySchema } from "@/domain/agent/logs";
import { guardLocalRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ agentId: string }> }) {
  const denied = guardLocalRequest(request);
  if (denied) {
    return denied;
  }

  const limitParam = new URL(request.url).searchParams.get("limit");
  const parsed = AgentLogQuerySchema.safeParse(limitParam === null ? {} : { limit: limitParam });
  if (!parsed.success) {
    return NextResponse.json({ error: "limit 값이 올바르지 않습니다.", issues: parsed.error.issues }, { status: 400 });
  }

  /** Registered-agent allowlist: only ids the repository currently observes may be read. */
  const { agentId } = await context.params;
  const snapshot = await dashboardRepository.getSnapshot();
  if (!snapshot.byId[agentId]) {
    return NextResponse.json({ error: `알 수 없는 에이전트입니다: ${agentId}` }, { status: 404 });
  }

  const logs = await agentLogRepository.readLines(agentId, parsed.data.limit);
  return NextResponse.json(logs, { headers: { "Cache-Control": "no-store" } });
}
