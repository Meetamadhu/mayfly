import { periodStart, type CostPeriod } from "./cost-view";
import { moneySeconds } from "./sizes";
import type { Environment, UsageDay, UsageMonth } from "./types";

/**
 * Cost reports by repository or by team, from the daily totals Mayfly keeps (each day is split by repository).
 * Money is the estimate the Cost page shows: awake time weighted by preview size, at the configured hourly cost.
 * "Always on" is what the same previews would have cost if they never slept, and the difference is what Mayfly saved.
 */

export type ReportBy = "repo" | "team";

export interface ReportRow {
  /** A repository (owner/name) or a team name. */
  name: string;
  awakeSeconds: number;
  asleepSeconds: number;
  /** What the awake time cost. */
  spend: number;
  /** What it would have cost if the previews never slept. */
  alwaysOn: number;
  saved: number;
  /** Previews that were up at some point in the period. */
  previews: number;
}

export interface CostReport {
  period: CostPeriod;
  by: ReportBy;
  /** First and last UTC day included, YYYY-MM-DD. */
  from: string;
  to: string;
  rows: ReportRow[];
  totals: Omit<ReportRow, "name">;
}

export const UNATTRIBUTED = "Not split by repository";

const DAY_MS = 86_400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type TeamRule = { team: string; patterns: string[] };

/**
 * PREVIEW_TEAMS: teams separated by ";", each "name=repo,repo". A repository can be written owner/name or owner/*.
 * Example: web=acme/site,acme/shop;platform=acme/infra-*;
 */
export function parseTeams(raw: string | undefined): TeamRule[] {
  const rules: TeamRule[] = [];
  for (const part of (raw ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const team = part.slice(0, eq).trim().slice(0, 60);
    const patterns = part
      .slice(eq + 1)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[\w.*-]+\/[\w.*-]+$/.test(item));
    if (team && patterns.length > 0) rules.push({ team, patterns });
  }
  return rules;
}

function matches(pattern: string, repository: string) {
  if (!pattern.includes("*")) return pattern === repository;
  const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return expression.test(repository);
}

/** The team a repository belongs to: the first rule that matches, otherwise its owner. */
export function teamFor(repository: string, rules: TeamRule[]) {
  const repo = repository.trim().toLowerCase();
  for (const rule of rules) if (rule.patterns.some((pattern) => matches(pattern, repo))) return rule.team;
  return repo.split("/")[0] || repo;
}

type Totals = { awake: number; asleep: number; awakeMoney: number; asleepMoney: number };
const empty = (): Totals => ({ awake: 0, asleep: 0, awakeMoney: 0, asleepMoney: 0 });

function add(total: Totals, usage: Partial<UsageDay> | undefined) {
  const money = moneySeconds(usage);
  total.awake += usage?.awakeSeconds ?? 0;
  total.asleep += usage?.asleepSeconds ?? 0;
  total.awakeMoney += money.awake;
  total.asleepMoney += money.asleep;
}

function time(value: string | null | undefined) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function buildCostReport(input: {
  usage: UsageMonth | undefined;
  environments: Environment[];
  costPerHour: number;
  period: CostPeriod;
  by: ReportBy;
  teams?: TeamRule[];
  now: number;
  isDemo?: (env: Environment) => boolean;
}): CostReport {
  const { usage, costPerHour, period, by, now } = input;
  const rules = input.teams ?? [];
  const start = periodStart(period, now);
  // The week is today and the six days before it (seven days), the same as the Cost page's totals.
  const firstMs = period === "week" ? now - 6 * DAY_MS : start;
  const first = dayKey(firstMs);
  const last = dayKey(now);
  const group = (repository: string) => (by === "team" ? teamFor(repository, rules) : repository.trim().toLowerCase());

  const totals = new Map<string, Totals>();
  const bump = (name: string, usageDay: Partial<UsageDay>) => {
    const row = totals.get(name) ?? empty();
    add(row, usageDay);
    totals.set(name, row);
  };

  for (let at = firstMs; dayKey(at) <= last; at += DAY_MS) {
    const day = usage?.days?.[dayKey(at)];
    if (!day) continue;
    // What's left of the day after the repositories we know about (days saved before the split existed).
    const rest: Required<Pick<UsageDay, "awakeSeconds" | "asleepSeconds">> & { awakeWeighted: number; asleepWeighted: number } = {
      awakeSeconds: day.awakeSeconds,
      asleepSeconds: day.asleepSeconds,
      awakeWeighted: moneySeconds(day).awake,
      asleepWeighted: moneySeconds(day).asleep,
    };
    for (const [repository, repoDay] of Object.entries(day.repos ?? {})) {
      bump(group(repository), repoDay);
      const money = moneySeconds(repoDay);
      rest.awakeSeconds -= repoDay.awakeSeconds;
      rest.asleepSeconds -= repoDay.asleepSeconds;
      rest.awakeWeighted -= money.awake;
      rest.asleepWeighted -= money.asleep;
    }
    if (rest.awakeSeconds > 0.5 || rest.asleepSeconds > 0.5) {
      bump(UNATTRIBUTED, {
        awakeSeconds: Math.max(0, rest.awakeSeconds),
        asleepSeconds: Math.max(0, rest.asleepSeconds),
        awakeWeighted: Math.max(0, rest.awakeWeighted),
        asleepWeighted: Math.max(0, rest.asleepWeighted),
      });
    }
  }

  // Previews that were up at some point in the period, per group.
  const previews = new Map<string, number>();
  for (const env of input.environments) {
    if (input.isDemo?.(env)) continue;
    const opened = time(env.createdAt);
    if (opened === null || opened > now) continue;
    if (env.status === "destroyed" && (time(env.destroyedAt) ?? 0) < start) continue;
    const name = group(env.repository);
    previews.set(name, (previews.get(name) ?? 0) + 1);
    if (!totals.has(name)) totals.set(name, empty());
  }

  const money = (seconds: number) => (seconds / 3600) * costPerHour;
  const rows: ReportRow[] = [...totals.entries()].map(([name, t]) => ({
    name,
    awakeSeconds: t.awake,
    asleepSeconds: t.asleep,
    spend: money(t.awakeMoney),
    alwaysOn: money(t.awakeMoney + t.asleepMoney),
    saved: money(t.asleepMoney),
    previews: previews.get(name) ?? 0,
  }));
  rows.sort((a, b) => b.spend - a.spend || b.awakeSeconds - a.awakeSeconds || a.name.localeCompare(b.name));

  const sum = <K extends keyof Omit<ReportRow, "name">>(key: K) => rows.reduce((acc, row) => acc + row[key], 0);
  // A preview is counted once per group, so the total is the number of distinct previews, not the sum of groups.
  const distinct = input.environments.filter((env) => {
    if (input.isDemo?.(env)) return false;
    const opened = time(env.createdAt);
    if (opened === null || opened > now) return false;
    return env.status !== "destroyed" || (time(env.destroyedAt) ?? 0) >= start;
  }).length;
  return {
    period,
    by,
    from: first,
    to: last,
    rows,
    totals: {
      awakeSeconds: sum("awakeSeconds"),
      asleepSeconds: sum("asleepSeconds"),
      spend: sum("spend"),
      alwaysOn: sum("alwaysOn"),
      saved: sum("saved"),
      previews: distinct,
    },
  };
}

/** A spreadsheet cell: quoted when needed, and made harmless if a spreadsheet would read it as a formula. */
export function csvCell(value: string | number) {
  let text = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);

export function reportToCsv(report: CostReport, currency: string) {
  const label = report.by === "team" ? "Team" : "Repository";
  const header = [label, "Awake hours", "Asleep hours", `Spend (${currency})`, `Always-on cost (${currency})`, `Saved (${currency})`, "Previews"];
  const line = (cells: (string | number)[]) => cells.map(csvCell).join(",");
  const rows = report.rows.map((row) => line([row.name, hours(row.awakeSeconds), hours(row.asleepSeconds), money(row.spend), money(row.alwaysOn), money(row.saved), row.previews]));
  const t = report.totals;
  const total = line(["Total", hours(t.awakeSeconds), hours(t.asleepSeconds), money(t.spend), money(t.alwaysOn), money(t.saved), t.previews]);
  return [`${csvCell(`Mayfly cost report, ${report.from} to ${report.to} (UTC)`)}`, line(header), ...rows, total].join("\r\n") + "\r\n";
}
