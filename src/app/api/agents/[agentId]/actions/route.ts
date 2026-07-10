import { NextResponse } from "next/server";

import { agentCommandRepository, dashboardRepository } from "@/data-access/repositories";
import { AgentActionRequestSchema } from "@/domain/agent/actions";
import { guardLocalRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
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

  const parsed = AgentActionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다.", issues: parsed.error.issues }, { status: 400 });
  }

  /** Registered-agent allowlist: only ids the repository currently observes may be acted upon. */
  const { agentId } = await context.params;
  const snapshot = await dashboardRepository.getSnapshot();
  if (!snapshot.byId[agentId]) {
    return NextResponse.json({ error: `알 수 없는 에이전트입니다: ${agentId}` }, { status: 404 });
  }

  const result = await agentCommandRepository.execute(agentId, parsed.data);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
