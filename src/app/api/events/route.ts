import { randomBytes } from "node:crypto";
import { requireAdmin } from "@/lib/admin";
import { buildsPullRequests, getConfig, repositoryAllowed } from "@/lib/config";
import { parseSimulatorEvent } from "@/lib/events";
import { json, resultResponse } from "@/lib/http";
import { applyPullRequestEvent } from "@/lib/lifecycle";
import { pullRequestHead } from "@/lib/pr-head";

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

  // No commit given: a real build uses the pull request's latest commit on GitHub, so the simulator never rolls a
  // preview back to an old one. The placeholder app has no real commits, so it gets a new random one, like a push.
  const event = parsed.event;
  if (!event.sha) {
    const demo = getConfig().demo;
    const isDemo = Boolean(demo && demo.repository === event.repository && demo.prNumber === event.prNumber);
    const realBuild = event.action !== "closed" && buildsPullRequests() && !isDemo && repositoryAllowed(event.repository);
    if (realBuild) {
      const head = await pullRequestHead(event.repository, event.prNumber);
      if (!head) {
        return json(
          { ok: false, code: "invalid", error: `Could not find the head of PR #${event.prNumber} in ${event.repository}.` },
          400,
        );
      }
      event.sha = head;
    } else {
      event.sha = randomBytes(8).toString("hex");
    }
  }
  return resultResponse(await applyPullRequestEvent(event, { wait: parsed.wait }));
}
