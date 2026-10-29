import { requireAdmin } from "@/lib/admin";
import { json, resultResponse } from "@/lib/http";
import { destroyEnvironment, getEnvironment, markIdle, recordActivity } from "@/lib/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const environment = await getEnvironment(id);
  if (!environment) return json({ ok: false, code: "not_found", error: "No environment with that id." }, 404);
  return json({ ok: true, environment });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const wait = url.searchParams.get("wait") === "1";
  if (action === "destroy" || action === "idle" || action === "activity") {
    const denied = requireAdmin(request);
    if (denied) return denied;
  }
  if (action === "destroy") return resultResponse(await destroyEnvironment(id, "manual", { wait }));
  if (action === "idle") return resultResponse(await markIdle(id));
  if (action === "activity") return resultResponse(await recordActivity(id));
  return json({ ok: false, code: "invalid", error: "Unknown action." }, 400);
}
