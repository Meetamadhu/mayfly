import { requireAdmin } from "@/lib/admin";
import { parseSimulatorEvent } from "@/lib/events";
import { json, resultResponse } from "@/lib/http";
import { applyPullRequestEvent } from "@/lib/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SIMULATOR !== "true") {
    return json({ ok: false, error: "The pull request simulator is disabled in production." }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "invalid", error: "Request body must be JSON." }, 400);
  }

  const parsed = parseSimulatorEvent(payload);
  if (!parsed.ok) return json({ ok: false, code: "invalid", error: parsed.error }, 400);
  return resultResponse(await applyPullRequestEvent(parsed.event, { wait: parsed.wait }));
}
