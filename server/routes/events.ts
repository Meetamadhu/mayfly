import express, { Router } from "express";
import { parseSimulatorEvent } from "@/lib/events";
import { applyPullRequestEvent } from "@/lib/lifecycle";
import { resolveSimulatorSha } from "@/lib/simulator";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson, sendLifecycle } from "../lib/respond";

export const eventsRouter = Router();

function strictJson(limit = "64kb") {
  const parser = express.json({ limit });
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    parser(req, res, (err?: unknown) => {
      if (err) {
        sendJson(res, { ok: false, code: "invalid", error: "Request body must be JSON." }, 400);
        return;
      }
      next();
    });
  };
}

eventsRouter.post(
  "/api/events",
  requireAdmin,
  (req, res, next) => {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_SIMULATOR !== "true") {
      sendJson(res, { ok: false, error: "The pull request simulator is disabled in production." }, 403);
      return;
    }
    next();
  },
  strictJson("64kb"),
  asyncHandler(async (req, res) => {
    const parsed = parseSimulatorEvent(req.body);
    if (!parsed.ok) {
      sendJson(res, { ok: false, code: "invalid", error: parsed.error }, 400);
      return;
    }

    const event = parsed.event;
    const resolved = await resolveSimulatorSha(event);
    if (!resolved.ok) {
      sendJson(res, { ok: false, code: "invalid", error: resolved.error }, 400);
      return;
    }
    event.sha = resolved.sha;
    sendLifecycle(res, await applyPullRequestEvent(event, { wait: parsed.wait }));
  }),
);
