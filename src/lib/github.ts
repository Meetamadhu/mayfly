import { createHmac, timingSafeEqual } from "node:crypto";
import type { PullRequestEvent } from "./types";

const HANDLED_ACTIONS = new Set(["opened", "synchronize", "closed", "reopened"]);

export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function parseGithubWebhook(
  eventName: string | null,
  payload: unknown,
): { ok: true; ignored: true } | { ok: true; ignored?: false; event: PullRequestEvent } | { ok: false; error: string } {
  if (eventName === "ping" || eventName !== "pull_request") {
    return { ok: true, ignored: true };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Webhook payload was empty." };
  }

  const body = payload as {
    action?: unknown;
    repository?: { full_name?: unknown };
    pull_request?: {
      number?: unknown;
      merged?: unknown;
      head?: { sha?: unknown; ref?: unknown };
    };
  };

  if (typeof body.action !== "string" || !HANDLED_ACTIONS.has(body.action)) {
    return { ok: true, ignored: true };
  }

  const repository = body.repository?.full_name;
  const prNumber = body.pull_request?.number;
  const sha = body.pull_request?.head?.sha;
  const branch = body.pull_request?.head?.ref;

  if (typeof repository !== "string" || typeof prNumber !== "number" || typeof sha !== "string" || typeof branch !== "string") {
    return { ok: false, error: "Webhook payload is missing repository, pull request, sha, or branch." };
  }

  return {
    ok: true,
    event: {
      action: body.action as PullRequestEvent["action"],
      repository,
      prNumber,
      sha,
      branch,
      merged: body.pull_request?.merged === true,
    },
  };
}
