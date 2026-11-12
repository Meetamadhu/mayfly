import express, { Router } from "express";
import { getConfig } from "@/lib/config";
import { parseGithubWebhook, readPayload, verifyGithubSignature } from "@/lib/github";
import { applyPullRequestEvent } from "@/lib/lifecycle";
import { asyncHandler, sendJson, sendLifecycle } from "../lib/respond";

export const webhooksRouter = Router();

webhooksRouter.get("/api/webhooks/github", (_req, res) => {
  sendJson(res, { ok: true, message: "Send GitHub pull_request events here with POST." });
});

webhooksRouter.post(
  "/api/webhooks/github",
  express.raw({ type: "*/*", limit: "5mb" }),
  asyncHandler(async (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const config = getConfig();
    const signatureHeader = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : null;

    if (config.webhookSecret) {
      if (!verifyGithubSignature(raw, signatureHeader, config.webhookSecret)) {
        sendJson(res, { ok: false, error: "Invalid webhook signature." }, 401);
        return;
      }
    } else if (process.env.NODE_ENV === "production") {
      sendJson(res, { ok: false, error: "GITHUB_WEBHOOK_SECRET is required in production." }, 401);
      return;
    }

    let payload: unknown;
    try {
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null;
      payload = readPayload(raw.toString("utf8"), contentType);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook body was not JSON.";
      sendJson(res, { ok: false, error: message }, 400);
      return;
    }

    const eventName = typeof req.headers["x-github-event"] === "string" ? req.headers["x-github-event"] : null;
    const parsed = parseGithubWebhook(eventName, payload);
    if (!parsed.ok) {
      sendJson(res, parsed, 400);
      return;
    }
    if (parsed.ignored) {
      sendJson(res, { ok: true, ignored: true });
      return;
    }
    sendLifecycle(res, await applyPullRequestEvent(parsed.event));
  }),
);
