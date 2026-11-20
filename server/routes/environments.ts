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
import { publicEnvironment, publicOverview } from "@/lib/public-view";
import { requireMember, whoIs } from "@/lib/access";
import { recordAudit } from "@/lib/users";
import type { LifecycleResult } from "@/lib/types";
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

/** Signed-in people (the admin and approved team members) see everything; everyone else the trimmed public view. */
async function isMember(req: { method: string; headers: Record<string, string | string[] | undefined> }) {
  return (await whoIs({ method: "GET", header: headerOf(req) })) !== null;
}

/** "acme/web #12" for the activity log, from whatever a lifecycle call returned. */
function targetOf(result: LifecycleResult) {
  const env = "environment" in result ? result.environment : undefined;
  return env ? `${env.repository} #${env.prNumber}` : null;
}

environmentsRouter.get(
  "/api/environments",
  asyncHandler(async (req, res) => {
    const overview = await getOverview();
    sendJson(res, (await isMember(req)) ? overview : publicOverview(overview));
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
    sendJson(res, { ok: true, environment: (await isMember(req)) ? environment : publicEnvironment(environment) });
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

    // Removing a preview is the admin's call. Team members can do the rest.
    if (action === "destroy") {
      const denied = checkAdmin({ method: req.method, header: headerOf(req) });
      if (denied) {
        sendJson(res, denied.status === 401 ? { ...denied.body, error: "Only the admin can remove previews." } : denied.body, denied.status === 401 ? 403 : denied.status);
        return;
      }
      const result = await destroyEnvironment(id, "manual", { wait });
      if (result.ok) await recordAudit({ name: "admin", role: "admin" }, "preview.remove", targetOf(result));
      sendLifecycle(res, result);
      return;
    }

    let actor: { name: string; role: "admin" | "user" } | null = null;
    if (
      action === "sleep" ||
      action === "activity" ||
      action === "extend" ||
      action === "keep_awake" ||
      action === "keep_awake_off"
    ) {
      const access = await requireMember({ method: req.method, header: headerOf(req) });
      if (!("actor" in access)) {
        sendJson(res, access.body, access.status);
        return;
      }
      actor = access.actor;
    }
    const logged = async (result: LifecycleResult, what: string, detail: string | null = null) => {
      if (result.ok && actor) await recordAudit(actor, what, targetOf(result), detail);
      sendLifecycle(res, result);
    };

    if (action === "sleep") {
      await logged(await sleepEnvironment(id), "preview.sleep");
      return;
    }
    if (action === "activity") {
      await logged(await recordActivity(id), "preview.mark_active");
      return;
    }
    if (action === "extend") {
      const hoursRaw = typeof req.query.hours === "string" ? req.query.hours : "";
      if (!/^-?\d+$/.test(hoursRaw)) {
        sendJson(res, { ok: false, code: "invalid", error: "hours must be an integer." }, 400);
        return;
      }
      const hours = Number(hoursRaw);
      await logged(await extendEnvironment(id, hours), "preview.extend", `by ${hours} h`);
      return;
    }
    if (action === "keep_awake") {
      const hoursRaw = typeof req.query.hours === "string" ? req.query.hours : "";
      if (!/^\d+$/.test(hoursRaw)) {
        sendJson(res, { ok: false, code: "invalid", error: "hours must be 1, 4, or 8." }, 400);
        return;
      }
      const hours = Number(hoursRaw);
      await logged(await keepAwakeEnvironment(id, hours), "preview.keep_awake", `for ${hours} h`);
      return;
    }
    if (action === "keep_awake_off") {
      await logged(await keepAwakeOffEnvironment(id), "preview.keep_awake_off");
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
