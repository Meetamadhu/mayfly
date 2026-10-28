import { getConfig } from "@/lib/config";
import { parseGithubWebhook, verifyGithubSignature } from "@/lib/github";
import { json, resultResponse } from "@/lib/http";
import { applyPullRequestEvent } from "@/lib/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readPayload(raw: string, contentType: string | null): unknown {
  if (!raw) return {};
  const type = contentType ?? "";
  if (type.includes("application/json") || raw.trimStart().startsWith("{")) {
    return JSON.parse(raw);
  }
  const payload = new URLSearchParams(raw).get("payload");
  if (!payload) {
    throw new Error("Set the webhook content type to application/json.");
  }
  return JSON.parse(payload);
}

export async function GET() {
  return json({ ok: true, message: "Send GitHub pull_request events here with POST." });
}

export async function POST(request: Request) {
  const raw = await request.text();
  const config = getConfig();
  const signature = request.headers.get("x-hub-signature-256");

  if (config.webhookSecret) {
    if (!verifyGithubSignature(raw, signature, config.webhookSecret)) {
      return json({ ok: false, error: "Invalid webhook signature." }, 401);
    }
  } else if (process.env.NODE_ENV === "production") {
    return json({ ok: false, error: "GITHUB_WEBHOOK_SECRET is required in production." }, 401);
  }

  let payload: unknown;
  try {
    payload = readPayload(raw, request.headers.get("content-type"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook body was not JSON.";
    return json({ ok: false, error: message }, 400);
  }

  const parsed = parseGithubWebhook(request.headers.get("x-github-event"), payload);
  if (!parsed.ok) return json(parsed, 400);
  if (parsed.ignored) return json({ ok: true, ignored: true });
  return resultResponse(await applyPullRequestEvent(parsed.event));
}
