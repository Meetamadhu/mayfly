import { Router } from "express";
import { checkAdmin } from "@/lib/admin";
import {
  destroyEnvironment,
  extendEnvironment,
  getEnvironment,
  getOverview,
  keepAwakeEnvironment,
  keepAwakeOffEnvironment,
  reap,
  recordActivity,
  sleepEnvironment,
} from "@/lib/lifecycle";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson, sendLifecycle } from "../lib/respond";

export const environmentsRouter = Router();

function headerOf(req: { headers: Record<string, string | string[] | undefined> }) {
  return (name: string): string | null => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
}

function parseId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 100) return null;
  return id;
}

environmentsRouter.get(
  "/api/environments",
  asyncHandler(async (_req, res) => {
    sendJson(res, await getOverview());
  }),
);

environmentsRouter.get(
  "/api/environments/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      sendJson(res, { ok: false, code: "invalid", error: "Invalid environment id." }, 400);
      return;
    }
    const environment = await getEnvironment(id);
    if (!environment) {
      sendJson(res, { ok: false, code: "not_found", error: "No environment with that id." }, 404);
      return;
    }
    sendJson(res, { ok: true, environment });
  }),
);

environmentsRouter.post(
  "/api/environments/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      sendJson(res, { ok: false, code: "invalid", error: "Invalid environment id." }, 400);
      return;
    }

    const action = typeof req.query.action === "string" ? req.query.action : null;
    const wait = req.query.wait === "1";

    if (
      action === "destroy" ||
      action === "sleep" ||
      action === "activity" ||
      action === "extend" ||
      action === "keep_awake" ||
      action === "keep_awake_off"
    ) {
      const denied = checkAdmin({ method: req.method, header: headerOf(req) });
      if (denied) {
        sendJson(res, denied.body, denied.status);
        return;
      }
    }

    if (action === "destroy") {
      sendLifecycle(res, await destroyEnvironment(id, "manual", { wait }));
      return;
    }
    if (action === "sleep") {
      sendLifecycle(res, await sleepEnvironment(id));
      return;
    }
    if (action === "activity") {
      sendLifecycle(res, await recordActivity(id));
      return;
    }
    if (action === "extend") {
      const hoursRaw = typeof req.query.hours === "string" ? req.query.hours : "";
      if (!/^-?\d+$/.test(hoursRaw)) {
        sendJson(res, { ok: false, code: "invalid", error: "hours must be an integer." }, 400);
        return;
      }
      const hours = Number(hoursRaw);
      sendLifecycle(res, await extendEnvironment(id, hours));
      return;
    }
    if (action === "keep_awake") {
      const hoursRaw = typeof req.query.hours === "string" ? req.query.hours : "";
      if (!/^\d+$/.test(hoursRaw)) {
        sendJson(res, { ok: false, code: "invalid", error: "hours must be 1, 4, or 8." }, 400);
        return;
      }
      const hours = Number(hoursRaw);
      sendLifecycle(res, await keepAwakeEnvironment(id, hours));
      return;
    }
    if (action === "keep_awake_off") {
      sendLifecycle(res, await keepAwakeOffEnvironment(id));
      return;
    }

    sendJson(res, { ok: false, code: "invalid", error: "Unknown action." }, 400);
  }),
);

environmentsRouter.post(
  "/api/reaper",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, await reap());
  }),
);
