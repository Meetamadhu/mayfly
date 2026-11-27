import { Router } from "express";
import { auditRows, auditToCsv } from "@/lib/audit";
import { checkHealth, opsMetrics } from "@/lib/health";
import { serverResources } from "@/lib/resources";
import { exclusive, loadState } from "@/lib/store";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

/**
 * Admin operations.
 *   GET /api/ops              health, metrics, server resources, instance name
 *   GET /api/ops/audit.csv    lifecycle events as a CSV download
 */
export const opsRouter = Router();

opsRouter.get(
  "/api/ops",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [health, metrics, resources] = await Promise.all([checkHealth({ fresh: true }), opsMetrics(), serverResources().catch(() => null)]);
    sendJson(res, {
      ok: true,
      health,
      metrics,
      resources,
      scaling: {
        note: "Each Mayfly host runs its own Docker daemon. To use more than one server, give each a disjoint PREVIEW_REPOS list (and the same MongoDB if you want a shared board), and point each repository's webhook at the host that owns it.",
        instance: health.instance,
        repositories: health.repositories,
      },
    });
  }),
);

opsRouter.get(
  "/api/ops/audit.csv",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const includeDestroyed = req.query.destroyed === "1" || req.query.destroyed === "true";
    const state = await exclusive(async () => loadState());
    const csv = auditToCsv(auditRows(state.environments, { includeDestroyed }));
    res
      .status(200)
      .set({
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mayfly-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      })
      .send(csv);
  }),
);
