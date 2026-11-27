import type { BudgetStatus } from "./budget";
import { formatHours, formatMoneyShort } from "./cost-view";
import type { CostReport } from "./cost-report";

/**
 * The weekly email: what the past seven days cost, how many hours previews slept instead of running, which
 * repositories and teams used the most, and where the month's budget stands. This file only decides when it's
 * due and writes it; automation.ts sends it.
 */

export interface ReportState {
  /** The week (ISO, "2026-W48") whose summary went out last. */
  lastWeekly: string | null;
}

export function asReportState(value: unknown): ReportState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const last = (value as { lastWeekly?: unknown }).lastWeekly;
  return typeof last === "string" && /^\d{4}-W\d{2}$/.test(last) ? { lastWeekly: last } : undefined;
}

const DAY_MS = 86_400_000;

/** The ISO week (Monday to Sunday, UTC) a moment is in, as "2026-W48", and when that week began. */
export function isoWeek(ms: number) {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = Date.UTC(year, 0, 4) - ((firstThursday.getUTCDay() + 6) % 7) * DAY_MS;
  const week = 1 + Math.round((monday - firstMonday) / (7 * DAY_MS));
  return { key: `${year}-W${String(week).padStart(2, "0")}`, mondayMs: monday };
}

export interface ReportSchedule {
  /** 1 is Monday, 7 is Sunday. */
  weekday: number;
  /** Hour in UTC, 0 to 23. */
  hour: number;
}

export const DEFAULT_REPORT_SCHEDULE: ReportSchedule = { weekday: 1, hour: 9 };

/** REPORT_WEEKDAY (1 to 7) and REPORT_HOUR_UTC (0 to 23). Bad values use the defaults: Monday, 09:00 UTC. */
export function reportScheduleFromEnv(env: Record<string, string | undefined> = process.env): ReportSchedule {
  const weekday = Number(env["REPORT_WEEKDAY"]);
  const hour = Number(env["REPORT_HOUR_UTC"]);
  return {
    weekday: Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : DEFAULT_REPORT_SCHEDULE.weekday,
    hour: env["REPORT_HOUR_UTC"] !== undefined && env["REPORT_HOUR_UTC"] !== "" && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_REPORT_SCHEDULE.hour,
  };
}

/** Due once per week, from the chosen day and hour. A server that was off then sends it when it's next up. */
export function weeklyDue(state: ReportState | undefined, now: number, schedule: ReportSchedule = DEFAULT_REPORT_SCHEDULE) {
  const { key, mondayMs } = isoWeek(now);
  const dueAt = mondayMs + (schedule.weekday - 1) * DAY_MS + schedule.hour * 3_600_000;
  return { key, due: now >= dueAt && state?.lastWeekly !== key };
}

export function recipientsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env["REPORT_EMAIL_TO"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(item))
    .slice(0, 20);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export interface Summary {
  subject: string;
  text: string;
  html: string;
}

export function buildWeeklySummary(input: {
  week: CostReport;
  teams: CostReport;
  budget: BudgetStatus | null;
  currency: string;
  boardUrl: string;
}): Summary {
  const { week, teams, budget, currency } = input;
  const t = week.totals;
  const saved = formatMoneyShort(t.saved, currency);
  const subject = `Mayfly weekly summary: ${formatHours(t.asleepSeconds)} saved, ${saved} less than always-on`;
  const top = (report: CostReport) => report.rows.filter((row) => row.awakeSeconds > 0 || row.previews > 0).slice(0, 5);
  const budgetLine =
    budget && budget.level !== "off" && budget.limit !== null
      ? `This month: ${formatMoneyShort(budget.spend, currency)} of the ${formatMoneyShort(budget.limit, currency)} budget (${budget.percent}%).${budget.paused ? " Previews are paused." : ""}`
      : null;

  const lines = [
    `Mayfly, ${week.from} to ${week.to} (UTC)`,
    "",
    `Previews slept for ${formatHours(t.asleepSeconds)} instead of running, and were awake for ${formatHours(t.awakeSeconds)}.`,
    `Spend ${formatMoneyShort(t.spend, currency)}. Always on, the same previews would have cost ${formatMoneyShort(t.alwaysOn, currency)}, so Mayfly saved ${saved}.`,
    `${t.previews} preview${t.previews === 1 ? "" : "s"} were up this week.`,
  ];
  const sections: { title: string; rows: CostReport["rows"] }[] = [
    { title: "By repository", rows: top(week) },
    { title: "By team", rows: top(teams) },
  ];
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    lines.push("", `${section.title}:`);
    for (const row of section.rows) lines.push(`  ${row.name}: ${formatMoneyShort(row.spend, currency)}, awake ${formatHours(row.awakeSeconds)}, saved ${formatMoneyShort(row.saved, currency)}`);
  }
  if (budgetLine) lines.push("", budgetLine);
  lines.push("", `Open the board: ${input.boardUrl}`);

  const table = (title: string, rows: CostReport["rows"]) =>
    rows.length === 0
      ? ""
      : `<h3 style="margin:20px 0 6px;font-size:14px">${escapeHtml(title)}</h3><table style="border-collapse:collapse;width:100%;font-size:13px">${rows
          .map(
            (row) =>
              `<tr><td style="padding:4px 8px 4px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(row.name)}</td><td style="padding:4px 0;border-bottom:1px solid #e5e7eb;text-align:right">${escapeHtml(formatMoneyShort(row.spend, currency))}</td><td style="padding:4px 0 4px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280">awake ${escapeHtml(formatHours(row.awakeSeconds))}</td></tr>`,
          )
          .join("")}</table>`;
  const html = `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 4px">Mayfly weekly summary</h2>
<p style="margin:0 0 16px;color:#6b7280;font-size:13px">${escapeHtml(week.from)} to ${escapeHtml(week.to)} (UTC)</p>
<p style="font-size:20px;margin:0 0 4px"><strong>${escapeHtml(formatHours(t.asleepSeconds))}</strong> saved</p>
<p style="margin:0 0 12px;font-size:14px">Previews slept instead of running. Awake for ${escapeHtml(formatHours(t.awakeSeconds))}. Spend ${escapeHtml(formatMoneyShort(t.spend, currency))} against ${escapeHtml(formatMoneyShort(t.alwaysOn, currency))} always on: <strong>${escapeHtml(saved)}</strong> saved across ${t.previews} preview${t.previews === 1 ? "" : "s"}.</p>
${table("By repository", top(week))}${table("By team", top(teams))}
${budgetLine ? `<p style="margin:20px 0 0;font-size:14px">${escapeHtml(budgetLine)}</p>` : ""}
<p style="margin:20px 0 0;font-size:13px"><a href="${escapeHtml(input.boardUrl)}">Open the board</a></p>
</body></html>`;
  return { subject, text: lines.join("\n"), html };
}
