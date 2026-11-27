import { moneySeconds } from "./sizes";
import type { UsageMonth } from "./types";

/**
 * A monthly spending limit. Mayfly warns at 80 % and, if asked to, pauses previews at 100 %.
 *
 * Spend is the estimate the Cost page shows: awake hours of this calendar month (UTC) weighted by preview size, at
 * the configured hourly cost. Paused means sleeping previews stay asleep and no new ones start; people who are
 * already looking at an awake preview are not cut off mid-click, and it goes to sleep on the next check.
 *
 * This module imports nothing from config or lifecycle, so the proxy, the lifecycle and the reaper can all use it.
 */

export const WARN_PERCENT = 80;
export const MAX_LIMIT = 10_000_000;

export interface BudgetSettings {
  /** Money per month, in the configured currency. Null: no limit. */
  monthlyLimit: number | null;
  /** Pause previews when the limit is reached. */
  pauseAtLimit: boolean;
  /** Which alerts were already sent this month, so each goes out once. */
  notified: { month: string; warned: boolean; reached: boolean } | null;
  /** The month in which an admin chose to keep previews running past the limit. */
  resumedMonth: string | null;
  updatedAt: string | null;
}

export function defaultBudget(): BudgetSettings {
  return { monthlyLimit: null, pauseAtLimit: false, notified: null, resumedMonth: null, updatedAt: null };
}

export function monthOf(ms: number) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Money spent so far this month. Usage from an earlier month doesn't count. */
export function monthSpend(usage: UsageMonth | undefined, costPerHour: number, month: string) {
  if (!usage || usage.month !== month) return 0;
  return (moneySeconds(usage).awake / 3600) * costPerHour;
}

export type BudgetLevel = "off" | "ok" | "warn" | "over";

export interface BudgetStatus {
  month: string;
  limit: number | null;
  spend: number;
  /** Spend as a share of the limit, rounded down. 0 when there's no limit. */
  percent: number;
  level: BudgetLevel;
  pauseAtLimit: boolean;
  /** Previews are paused right now. */
  paused: boolean;
  /** The limit is reached and an admin chose to keep going for the rest of the month. */
  resumed: boolean;
}

export function budgetStatus(settings: BudgetSettings, spend: number, month: string): BudgetStatus {
  const limit = settings.monthlyLimit;
  if (limit === null || limit <= 0) {
    return { month, limit: null, spend, percent: 0, level: "off", pauseAtLimit: settings.pauseAtLimit, paused: false, resumed: false };
  }
  const percent = Math.floor((spend / limit) * 100);
  const level: BudgetLevel = percent >= 100 ? "over" : percent >= WARN_PERCENT ? "warn" : "ok";
  const resumed = level === "over" && settings.resumedMonth === month;
  return {
    month,
    limit,
    spend,
    percent,
    level,
    pauseAtLimit: settings.pauseAtLimit,
    paused: level === "over" && settings.pauseAtLimit && !resumed,
    resumed,
  };
}

export type BudgetAlert = "warn" | "over";

/**
 * What to tell people now, and what to remember so it isn't said again. A month sends each alert once. Falling
 * back below a threshold (a higher limit, a new month) lets the alert fire again if it's crossed again.
 */
export function budgetAlertFor(settings: BudgetSettings, status: BudgetStatus): { alert: BudgetAlert | null; notified: BudgetSettings["notified"] } {
  if (status.level === "off") return { alert: null, notified: null };
  const before = settings.notified?.month === status.month ? settings.notified : { month: status.month, warned: false, reached: false };
  let warned = before.warned && status.percent >= WARN_PERCENT;
  let reached = before.reached && status.percent >= 100;
  let alert: BudgetAlert | null = null;
  if (status.percent >= 100 && !before.reached) {
    alert = "over";
    reached = true;
    warned = true;
  } else if (status.percent >= WARN_PERCENT && status.percent < 100 && !before.warned) {
    alert = "warn";
    warned = true;
  }
  return { alert, notified: { month: status.month, warned, reached } };
}

/** The wording for an alert. */
export function budgetAlertText(alert: BudgetAlert, status: BudgetStatus, currency: string) {
  const money = (value: number) => `${currency}${value.toFixed(2)}`;
  const limit = money(status.limit ?? 0);
  if (alert === "warn") {
    return {
      title: `previews have used ${status.percent}% of this month's budget`,
      lines: [`${money(status.spend)} of ${limit} so far.`, status.pauseAtLimit ? "Previews will be paused when the limit is reached." : "Previews keep running past the limit."],
    };
  }
  return {
    title: status.paused ? "monthly budget reached: previews are paused" : "monthly budget reached",
    lines: [
      `${money(status.spend)} of ${limit} this month.`,
      status.paused ? "Sleeping previews stay asleep and new ones aren't started. Raise the limit or resume on the Cost page." : "Previews keep running because pausing is off.",
    ],
  };
}

export type BudgetParse = { ok: true; settings: BudgetSettings } | { ok: false; error: string };

/** Check what the Cost page sends. A changed limit or pause setting clears an earlier "resume". */
export function parseBudgetInput(raw: unknown, existing: BudgetSettings, now = new Date().toISOString()): BudgetParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the budget as JSON." };
  const body = raw as Record<string, unknown>;
  let monthlyLimit = existing.monthlyLimit;
  if ("monthlyLimit" in body) {
    const value = body.monthlyLimit;
    if (value === null || value === "" || value === undefined) {
      monthlyLimit = null;
    } else {
      const number = typeof value === "string" ? Number(value.trim()) : value;
      if (typeof number !== "number" || !Number.isFinite(number) || number <= 0 || number > MAX_LIMIT) {
        return { ok: false, error: "The monthly limit must be an amount above 0." };
      }
      monthlyLimit = Math.round(number * 100) / 100;
    }
  }
  let pauseAtLimit = existing.pauseAtLimit;
  if ("pauseAtLimit" in body) {
    if (typeof body.pauseAtLimit !== "boolean") return { ok: false, error: "Pause at the limit must be on or off." };
    pauseAtLimit = body.pauseAtLimit;
  }
  const changed = monthlyLimit !== existing.monthlyLimit || pauseAtLimit !== existing.pauseAtLimit;
  return {
    ok: true,
    settings: { ...existing, monthlyLimit, pauseAtLimit, resumedMonth: changed ? null : existing.resumedMonth, updatedAt: now },
  };
}

/** Read stored budget settings. Damaged ones are dropped, so there's no limit rather than a broken load. */
export function asBudget(value: unknown): BudgetSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const limit = raw.monthlyLimit;
  const monthlyLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0 && limit <= MAX_LIMIT ? limit : null;
  const note = raw.notified as Record<string, unknown> | null | undefined;
  const notified =
    note && typeof note === "object" && typeof note.month === "string" && /^\d{4}-\d{2}$/.test(note.month)
      ? { month: note.month, warned: note.warned === true, reached: note.reached === true }
      : null;
  return {
    monthlyLimit,
    pauseAtLimit: raw.pauseAtLimit === true,
    notified,
    resumedMonth: typeof raw.resumedMonth === "string" && /^\d{4}-\d{2}$/.test(raw.resumedMonth) ? raw.resumedMonth : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

const holder = globalThis as unknown as { __mayflyBudget?: BudgetStatus };

/** The newest status. Set on every reaper tick and when settings change. Null until the first check. */
export function currentBudgetStatus(): BudgetStatus | null {
  return holder.__mayflyBudget ?? null;
}

export function setCurrentBudgetStatus(status: BudgetStatus | null) {
  if (status) holder.__mayflyBudget = status;
  else delete holder.__mayflyBudget;
}

/** True while previews are paused by the budget. */
export function previewsPaused() {
  return currentBudgetStatus()?.paused === true;
}

export const PAUSED_MESSAGE =
  "Previews are paused because this month's budget has been reached. An admin can raise the limit or resume them on the Cost page.";
