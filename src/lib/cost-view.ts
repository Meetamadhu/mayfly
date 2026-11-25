import { moneySeconds } from "./sizes";
import type { Environment, UsageMonth } from "./types";

/**
 * The Cost page's numbers for a chosen period (the last 7 days, or this calendar month), worked out from the
 * awake/asleep totals Mayfly keeps per day and from the preview records. Everything is an estimate at the
 * configured hourly cost; a sleeping preview costs nothing.
 */

export type CostPeriod = "week" | "month";
export const COST_PERIODS: { id: CostPeriod; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const DAY_MS = 86_400_000;

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** When the period starts: seven days ago, or midnight UTC on the 1st (usage is kept per UTC day). */
export function periodStart(period: CostPeriod, now: number) {
  if (period === "week") return now - 7 * DAY_MS;
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * The period's awake and asleep seconds, and the same weighted by each preview's size (for money). The month uses
 * Mayfly's monthly totals; the week adds up the last 7 days.
 */
export function periodSeconds(usage: UsageMonth | undefined, period: CostPeriod, now: number) {
  if (period === "month") {
    const money = moneySeconds(usage);
    return { awake: usage?.awakeSeconds ?? 0, asleep: usage?.asleepSeconds ?? 0, awakeMoney: money.awake, asleepMoney: money.asleep };
  }
  let awake = 0;
  let asleep = 0;
  let awakeMoney = 0;
  let asleepMoney = 0;
  for (let back = 0; back < 7; back += 1) {
    const day = usage?.days?.[dayKey(now - back * DAY_MS)];
    const money = moneySeconds(day);
    awake += day?.awakeSeconds ?? 0;
    asleep += day?.asleepSeconds ?? 0;
    awakeMoney += money.awake;
    asleepMoney += money.asleep;
  }
  return { awake, asleep, awakeMoney, asleepMoney };
}

export type SpendBar = { label: string; title: string; always: number; mayfly: number };

/**
 * The chart's bars. Week: one per day for the last 7 days. Month: one per week of this month (days 1–7, 8–14, …),
 * up to this week.
 */
export function spendBars(usage: UsageMonth | undefined, period: CostPeriod, costPerHour: number, now: number): SpendBar[] {
  const cost = (seconds: number) => (seconds / 3600) * costPerHour;
  const day = (ms: number) => usage?.days?.[dayKey(ms)];
  if (period === "week") {
    const bars: SpendBar[] = [];
    for (let back = 6; back >= 0; back -= 1) {
      const ms = now - back * DAY_MS;
      const totals = moneySeconds(day(ms));
      const awake = totals.awake;
      const asleep = totals.asleep;
      const date = new Date(ms);
      bars.push({
        label: date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
        title: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }),
        always: cost(awake + asleep),
        mayfly: cost(awake),
      });
    }
    return bars;
  }
  const start = periodStart("month", now);
  const today = new Date(now).getUTCDate();
  const monthName = new Date(now).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  const daysInMonth = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0)).getUTCDate();
  const bars: SpendBar[] = [];
  for (let first = 1, week = 1; first <= today; first += 7, week += 1) {
    const last = Math.min(first + 6, daysInMonth);
    let awake = 0;
    let asleep = 0;
    for (let d = first; d <= Math.min(last, today); d += 1) {
      const totals = moneySeconds(day(start + (d - 1) * DAY_MS));
      awake += totals.awake;
      asleep += totals.asleep;
    }
    bars.push({ label: `Wk ${week}`, title: `${first}–${last} ${monthName}`, always: cost(awake + asleep), mayfly: cost(awake) });
  }
  return bars;
}

function time(value: string | null | undefined) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Previews that were up at some point in the period (opened before now, not removed before it began). */
export function previewsInPeriod(environments: Environment[], start: number, now: number) {
  return environments.filter((env) => {
    const opened = time(env.createdAt);
    if (opened === null || opened > now) return false;
    if (env.status !== "destroyed") return true;
    return (time(env.destroyedAt) ?? 0) >= start;
  }).length;
}

/** Removals in the period, and how many of them followed a merge. */
export function removalsInPeriod(environments: Environment[], start: number) {
  const removed = environments.filter((env) => env.status === "destroyed" && (time(env.destroyedAt) ?? 0) >= start);
  return { total: removed.length, merged: removed.filter((env) => env.destroyReason === "merged").length };
}

/**
 * "Estimate your own": a month of previews for a team that opens `perWeek` of them, each open for `lifespanDays`
 * and looked at for `hoursAwake` a day. Always on means awake the whole time it's open; with Mayfly it's awake
 * only for those hours.
 */
export function estimateMonthly(options: { perWeek: number; hoursAwake: number; lifespanDays: number; costPerHour: number }) {
  const { perWeek, lifespanDays, costPerHour } = options;
  const hoursAwake = Math.min(24, Math.max(0, options.hoursAwake));
  const previewsPerMonth = (perWeek * 52) / 12;
  const openHours = previewsPerMonth * Math.max(0, lifespanDays) * 24;
  return { always: openHours * costPerHour, mayfly: openHours * (hoursAwake / 24) * costPerHour };
}

/** "$108", "$14", "$3.60": whole amounts above $100, cents below. */
export function formatMoneyShort(amount: number, currency = "$") {
  if (!Number.isFinite(amount) || amount <= 0) return `${currency}0`;
  if (amount >= 100) return `${currency}${Math.round(amount).toLocaleString()}`;
  if (amount < 0.01) return `< ${currency}0.01`;
  return `${currency}${amount.toFixed(2)}`;
}

/** "142 h", "36 min", "0 h". */
export function formatHours(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 h";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  const hours = seconds / 3600;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours).toLocaleString()} h`;
}
