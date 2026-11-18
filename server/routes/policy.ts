import express, { Router } from "express";
import { getPolicyView, savePolicy } from "@/lib/lifecycle";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

/** TTL policies: read and save. Admin only (the save also needs a same-origin request, via checkAdmin). */
export const policyRouter = Router();

policyRouter.get(
  "/api/admin/policy",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, { ok: true, ...(await getPolicyView()) });
  }),
);

policyRouter.put(
  "/api/admin/policy",
  requireAdmin,
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const result = await savePolicy(req.body);
    if (!result.ok) {
      sendJson(res, { ok: false, code: "invalid", error: result.error }, 400);
      return;
    }
    sendJson(res, { ok: true, ...result.view, gates: result.gates });
  }),
);
