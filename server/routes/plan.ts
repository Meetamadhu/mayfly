import express, { Router } from "express";
import { getConfig } from "@/lib/config";
import { DEFAULT_PLAN, PLAN_IDS, PLANS, currentPlan, isPlanId, planUsage } from "@/lib/plans";
import { exclusive, loadState, saveState, type State } from "@/lib/store";
import type { Environment } from "@/lib/types";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

/**
 * The plan (demo pricing).
 *   GET  /api/plan   anyone: the plans, the current one and what's in use against it
 *   POST /api/plan   admins: { plan: "free" | "team" | "business" } switches plan. A demo checkout: nothing is charged.
 */
export const planRouter = Router();

const json = express.json({ limit: "4kb" });

function isDemo(env: Environment) {
  const demo = getConfig().demo;
  return Boolean(demo && env.repository === demo.repository && env.prNumber === demo.prNumber);
}

function overview(state: State) {
  return {
    ok: true,
    demo: true,
    currency: "INR",
    current: { id: currentPlan(state.plan).id, since: state.plan?.since ?? null, chosen: Boolean(state.plan) },
    defaultPlan: DEFAULT_PLAN,
    plans: PLAN_IDS.map((id) => PLANS[id]),
    usage: planUsage(state.environments, isDemo),
  };
}

planRouter.get(
  "/api/plan",
  asyncHandler(async (_req, res) => {
    sendJson(res, overview(await loadState()));
  }),
);

planRouter.post(
  "/api/plan",
  requireAdmin,
  (req, res, next) =>
    json(req, res, (err?: unknown) => {
      if (err) {
        sendJson(res, { ok: false, code: "invalid", error: "Send the plan as JSON, like {\"plan\":\"team\"}." }, 400);
        return;
      }
      next();
    }),
  asyncHandler(async (req, res) => {
    const wanted = (req.body as { plan?: unknown } | undefined)?.plan;
    if (!isPlanId(wanted)) {
      sendJson(res, { ok: false, code: "invalid", error: "Pick one of the plans: free, team or business." }, 400);
      return;
    }
    const state = await exclusive(async () => {
      const current = await loadState();
      if (currentPlan(current.plan).id !== wanted || !current.plan) {
        current.plan = { id: wanted, since: new Date().toISOString(), demo: true };
        await saveState(current);
      }
      return current;
    });
    sendJson(res, overview(state));
  }),
);
