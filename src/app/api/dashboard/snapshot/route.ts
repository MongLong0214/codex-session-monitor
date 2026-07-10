import { NextResponse } from "next/server";

import { dashboardRepository } from "@/data-access/repositories";
import { guardLocalRequest } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalRequest(request);
  if (denied) {
    return denied;
  }

  const snapshot = await dashboardRepository.getSnapshot();
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
