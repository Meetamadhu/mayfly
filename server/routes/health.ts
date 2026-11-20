import { Router } from "express";
import { checkAdmin } from "@/lib/admin";
import { checkHealth } from "@/lib/health";
import { asyncHandler, sendJson } from "../lib/respond";

export const healthRouter = Router();

function headerOf(req: { headers: Record<string, string | string[] | undefined> }) {
  return (name: string): string | null => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
}

/**
 * For an uptime monitor: 200 when Mayfly can do its job, 503 when it can't. Everyone sees ok/status;
 * signed-in admins also see which check failed and why.
 */
healthRouter.get(
  "/api/health",
  asyncHandler(async (req, res) => {
    const report = await checkHealth();
    const status = report.ok ? 200 : 503;
    const admin = checkAdmin({ method: req.method, header: headerOf(req) }) === null;
    if (admin) {
      sendJson(res, report, status);
      return;
    }
    sendJson(res, { ok: report.ok, status: report.ok ? "ok" : "degraded", checkedAt: report.checkedAt }, status);
  }),
);
