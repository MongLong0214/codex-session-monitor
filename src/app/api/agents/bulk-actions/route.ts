import { NextResponse } from "next/server";

import { agentCommandRepository, dashboardRepository } from "@/data-access/repositories";
import type { AgentActionResult, BulkAgentActionResponse } from "@/domain/agent/actions";
import { BulkAgentActionRequestSchema } from "@/domain/agent/actions";
import { guardLocalRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = guardLocalRequest(request);
  if (denied) {
    return denied;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문을 파싱하지 못했습니다." }, { status: 400 });
  }

  const parsed = BulkAgentActionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다.", issues: parsed.error.issues }, { status: 400 });
  }

  const { agentIds, action, force } = parsed.data;
  const snapshot = await dashboardRepository.getSnapshot();

  /** Unknown ids degrade to a per-item "skipped" result instead of failing the whole batch. */
  const knownIds = agentIds.filter((agentId) => snapshot.byId[agentId] !== undefined);
  const executed = await agentCommandRepository.executeBulk(knownIds, action, force);
  const resultById = new Map(executed.map((result) => [result.agentId, result]));

  const results: AgentActionResult[] = agentIds.map(
    (agentId) =>
      resultById.get(agentId) ?? {
        agentId,
        action,
        status: "skipped",
        message: "등록되지 않은 에이전트입니다.",
      },
  );

  const response: BulkAgentActionResponse = { results };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
