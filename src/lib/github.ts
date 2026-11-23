import { createHmac, timingSafeEqual } from "node:crypto";
import type { PullRequestEvent } from "./types";

const HANDLED_ACTIONS = new Set(["opened", "synchronize", "closed", "reopened", "labeled", "unlabeled"]);

/** HMAC over the exact request bytes (string or Buffer). GitHub signs the raw body, not a re-parsed JSON form. */
export function verifyGithubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Parse JSON or form-encoded `payload=` webhook bodies after the signature has been checked. */
export function readPayload(raw: string, contentType: string | null): unknown {
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


/** A pull request title, shown on the board: control characters removed, spaces tidied, at most 200 characters. */
export function cleanTitle(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const title = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : undefined;
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
      title?: unknown;
      labels?: unknown;
      user?: { login?: unknown } | null;
      head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null };
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

  const labels = Array.isArray(body.pull_request?.labels)
    ? (body.pull_request.labels as unknown[])
        .map((label) => (label && typeof label === "object" ? (label as { name?: unknown }).name : null))
        .filter((name): name is string => typeof name === "string")
        .slice(0, 100)
    : undefined;

  return {
    ok: true,
    event: {
      action: body.action as PullRequestEvent["action"],
      repository,
      prNumber,
      sha,
      branch,
      merged: body.pull_request?.merged === true,
      labels,
      author:
        typeof body.pull_request?.user?.login === "string" ? body.pull_request.user.login.slice(0, 100) : undefined,
      title: cleanTitle(body.pull_request?.title),
      // GitHub sends no head repo when the fork was deleted. An empty value counts as a fork.
      headRepository:
        typeof body.pull_request?.head?.repo?.full_name === "string" ? body.pull_request.head.repo.full_name : "",
    },
  };
}
