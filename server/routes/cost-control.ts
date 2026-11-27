import express, { Router, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { sendWeeklySummary } from "@/lib/automation";
import {
  budgetStatus,
  defaultBudget,
  monthOf,
  monthSpend,
  parseBudgetInput,
  setCurrentBudgetStatus,
  type BudgetSettings,
} from "@/lib/budget";
import { getConfig, previewCostPerHour, previewCurrency } from "@/lib/config";
import { buildCostReport, parseTeams, reportToCsv } from "@/lib/cost-report";
import { getEnvironment, recheckEnvironment, setScheduledWake } from "@/lib/lifecycle";
import { mailSettings } from "@/lib/mailer";
import { describeWindow, parseSchedules, defaultSchedules } from "@/lib/schedule";
import { dataDir, exclusive, loadState, saveState } from "@/lib/store";
import type { State } from "@/lib/store";
import { isImageKind, visualDir } from "@/lib/visual-diff";
import { isoWeek, recipientsFromEnv, reportScheduleFromEnv } from "@/lib/weekly-report";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson, sendLifecycle } from "../lib/respond";

/**
 * Cost and control, admins only.
 *   GET  /api/budget                     the monthly limit, where spend stands, and whether email is set up
 *   PUT  /api/budget                     change the limit or "pause at the limit"
 *   POST /api/budget/resume              keep previews running past the limit for the rest of the month
 *   GET  /api/cost-report                ?period=week|month &by=repo|team &format=csv
 *   POST /api/cost-report/email          send the weekly summary now
 *   GET  /api/schedules                  awake hours for repositories
 *   PUT  /api/schedules                  replace them
 *   PUT  /api/environments/:id/wake      wake one preview at a time, and keep it awake for a while (DELETE cancels)
 *   POST /api/environments/:id/checks    run the smoke checks and/or the comparison again
 *   GET  /api/environments/:id/visual/:kind   a screenshot (preview, production or diff) as a PNG
 */
export const costControlRouter = Router();

const json = express.json({ limit: "64kb" });
const parseBody = (req: Request, res: Response, next: () => void) =>
  json(req, res, (err?: unknown) => {
    if (err) {
      sendJson(res, { ok: false, code: "invalid", error: "Send JSON (64 KB at most)." }, 400);
      return;
    }
    next();
  });

function idFrom(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length <= 100 ? value : null;
}

function budgetView(state: State, now = Date.now()) {
  const settings = state.budget ?? defaultBudget();
  const month = monthOf(now);
  const status = budgetStatus(settings, monthSpend(state.usage, previewCostPerHour(), month), month);
  return { status, settings: { monthlyLimit: settings.monthlyLimit, pauseAtLimit: settings.pauseAtLimit } };
}

function emailView() {
  const mail = mailSettings();
  const recipients = recipientsFromEnv().length;
  const schedule = reportScheduleFromEnv();
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    configured: mail.ok && recipients > 0,
    problem: !mail.ok ? mail.problem : recipients === 0 ? "Add REPORT_EMAIL_TO, the address that should get the summary." : null,
    recipients,
    when: `${days[schedule.weekday - 1]} at ${String(schedule.hour).padStart(2, "0")}:00 UTC`,
  };
}

async function budgetResponse() {
  const state = await exclusive(async () => loadState());
  return { ok: true, ...budgetView(state), currency: previewCurrency(), email: emailView(), lastWeekly: state.reports?.lastWeekly ?? null, thisWeek: isoWeek(Date.now()).key };
}

costControlRouter.get(
  "/api/budget",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, await budgetResponse());
  }),
);

costControlRouter.put(
  "/api/budget",
  requireAdmin,
  parseBody,
  asyncHandler(async (req, res) => {
    const result = await exclusive(async () => {
      const state = await loadState();
      const parsed = parseBudgetInput(req.body, state.budget ?? defaultBudget());
      if (!parsed.ok) return parsed;
      state.budget = parsed.settings as BudgetSettings;
      await saveState(state);
      // Takes effect now: a higher limit unpauses previews, a lower one can pause them.
      setCurrentBudgetStatus(budgetView(state).status);
      return parsed;
    });
    if (!result.ok) {
      sendJson(res, { ok: false, code: "invalid", error: result.error }, 400);
      return;
    }
    sendJson(res, await budgetResponse());
  }),
);

costControlRouter.post(
  "/api/budget/resume",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await exclusive(async () => {
      const state = await loadState();
      const settings = state.budget ?? defaultBudget();
      state.budget = { ...settings, resumedMonth: monthOf(Date.now()), updatedAt: new Date().toISOString() };
      await saveState(state);
      setCurrentBudgetStatus(budgetView(state).status);
    });
    sendJson(res, await budgetResponse());
  }),
);

costControlRouter.get(
  "/api/cost-report",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const period = req.query.period === "week" ? "week" : "month";
    const by = req.query.by === "team" ? "team" : "repo";
    const state = await exclusive(async () => loadState());
    const demo = getConfig().demo;
    const report = buildCostReport({
      usage: state.usage,
      environments: state.environments,
      costPerHour: previewCostPerHour(),
      period,
      by,
      teams: parseTeams(process.env["PREVIEW_TEAMS"]),
      now: Date.now(),
      isDemo: (env) => Boolean(demo && env.repository === demo.repository && env.prNumber === demo.prNumber),
    });
    if (req.query.format === "csv") {
      res
        .status(200)
        .set({
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="mayfly-cost-${by}-${report.from}-to-${report.to}.csv"`,
          "cache-control": "no-store",
        })
        .send(reportToCsv(report, previewCurrency()));
      return;
    }
    sendJson(res, { ok: true, report, currency: previewCurrency(), teams: parseTeams(process.env["PREVIEW_TEAMS"]).length > 0 });
  }),
);

costControlRouter.post(
  "/api/cost-report/email",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const sent = await sendWeeklySummary(Date.now());
    if (!sent.ok) {
      sendJson(res, { ok: false, code: "invalid", error: sent.error }, 409);
      return;
    }
    sendJson(res, { ok: true, to: sent.to.length, subject: sent.subject });
  }),
);

function schedulesView(state: State) {
  const settings = state.schedules ?? defaultSchedules();
  return { ok: true, windows: settings.windows.map((window) => ({ ...window, label: describeWindow(window) })), updatedAt: settings.updatedAt };
}

costControlRouter.get(
  "/api/schedules",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, schedulesView(await exclusive(async () => loadState())));
  }),
);

costControlRouter.put(
  "/api/schedules",
  requireAdmin,
  parseBody,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { windows?: unknown };
    const parsed = parseSchedules(body.windows === undefined ? [] : { windows: body.windows });
    if (!parsed.ok) {
      sendJson(res, { ok: false, code: "invalid", error: parsed.error }, 400);
      return;
    }
    const state = await exclusive(async () => {
      const fresh = await loadState();
      fresh.schedules = parsed.settings;
      await saveState(fresh);
      return fresh;
    });
    sendJson(res, schedulesView(state));
  }),
);

costControlRouter.put(
  "/api/environments/:id/wake",
  requireAdmin,
  parseBody,
  asyncHandler(async (req, res) => {
    const id = idFrom(req.params.id);
    if (!id) {
      sendJson(res, { ok: false, code: "invalid", error: "Invalid environment id." }, 400);
      return;
    }
    sendLifecycle(res, await setScheduledWake(id, req.body));
  }),
);

costControlRouter.delete(
  "/api/environments/:id/wake",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = idFrom(req.params.id);
    if (!id) {
      sendJson(res, { ok: false, code: "invalid", error: "Invalid environment id." }, 400);
      return;
    }
    sendLifecycle(res, await setScheduledWake(id, null));
  }),
);

costControlRouter.post(
  "/api/environments/:id/checks",
  requireAdmin,
  parseBody,
  asyncHandler(async (req, res) => {
    const id = idFrom(req.params.id);
    if (!id) {
      sendJson(res, { ok: false, code: "invalid", error: "Invalid environment id." }, 400);
      return;
    }
    const which = req.body?.which === "smoke" || req.body?.which === "visual" ? req.body.which : "both";
    sendLifecycle(res, await recheckEnvironment(id, which));
  }),
);

costControlRouter.get(
  "/api/environments/:id/visual/:kind",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = idFrom(req.params.id);
    const kind = Array.isArray(req.params.kind) ? req.params.kind[0] : req.params.kind;
    if (!id || !isImageKind(kind)) {
      sendJson(res, { ok: false, code: "invalid", error: "Choose preview, production or diff." }, 400);
      return;
    }
    const env = await getEnvironment(id);
    const file = path.join(visualDir(dataDir(), id), `${kind}.png`);
    if (!env || !existsSync(file)) {
      sendJson(res, { ok: false, code: "not_found", error: "There's no screenshot for this preview yet." }, 404);
      return;
    }
    res.status(200).set({ "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.sendFile(file);
  }),
);
