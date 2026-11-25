import { hourlyRate } from "./sizes";
import { isLiveStatus, type DestroyReason, type Environment } from "./types";

/**
 * Fleet numbers for the Cost & savings page, worked out from the preview records Mayfly already keeps
 * (removed previews stay in its state with createdAt, destroyedAt and destroyReason). Nothing is estimated
 * here except the hourly cost, which uses the configured PREVIEW_COST_PER_HOUR.
 */

export const FLEET_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REMOVAL_ORDER: DestroyReason[] = ["merged", "closed", "expired", "budget", "manual", "idle", "failed", "stuck"];

export interface FleetStats {
  /** Live previews awake (or waking) right now, and asleep. */
  awakeNow: number;
  asleepNow: number;
  /** Estimated cost per hour of the previews awake right now. */
  burnPerHour: number;
  /** Previews opened in the window. */
  created: number;
  /** Most previews alive at the same moment in the window. */
  peak: number;
  peakAt: string | null;
  /** Previews removed in the window, by reason. */
  removed: number;
  reasons: Partial<Record<DestroyReason, number>>;
  /** Share of removals Mayfly did on its own (PR closed or merged, lifetime ended, failed/stuck cleanup). */
  automaticShare: number | null;
  /** Lifetime of previews removed in the window that had worked (failed and stuck ones left out). */
  averageLifespanMs: number | null;
  medianLifespanMs: number | null;
  lifespanCount: number;
}

const AUTOMATIC = new Set<DestroyReason>(["merged", "closed", "expired", "idle", "failed", "stuck"]);

function time(value: string | null | undefined) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function fleetStats(
  environments: Environment[],
  options: { now: number; costPerHour: number; isDemo: (env: Environment) => boolean },
): FleetStats {
  const { now, costPerHour, isDemo } = options;
  const start = now - FLEET_WINDOW_DAYS * DAY_MS;
  const envs = environments.filter((env) => !isDemo(env));

  const live = envs.filter((env) => isLiveStatus(env.status));
  const awakeNow = live.filter((env) => env.sleep === "awake" || env.sleep === "waking").length;
  const asleepNow = live.filter((env) => env.sleep === "asleep").length;

  const created = envs.filter((env) => (time(env.createdAt) ?? 0) >= start).length;

  const removedList = envs.filter((env) => env.status === "destroyed" && (time(env.destroyedAt) ?? 0) >= start);
  const reasons: Partial<Record<DestroyReason, number>> = {};
  for (const env of removedList) {
    const reason = env.destroyReason ?? "manual";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const automatic = removedList.filter((env) => AUTOMATIC.has(env.destroyReason ?? "manual")).length;

  const lifespans = removedList
    .filter((env) => env.destroyReason !== "failed" && env.destroyReason !== "stuck")
    .map((env) => (time(env.destroyedAt) ?? 0) - (time(env.createdAt) ?? 0))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const average = lifespans.length ? lifespans.reduce((sum, ms) => sum + ms, 0) / lifespans.length : null;
  const median = lifespans.length
    ? lifespans.length % 2
      ? lifespans[(lifespans.length - 1) / 2]
      : (lifespans[lifespans.length / 2 - 1] + lifespans[lifespans.length / 2]) / 2
    : null;

  // Peak: sweep every preview's [opened, removed or now] span that overlaps the window.
  const points: { at: number; delta: number }[] = [];
  for (const env of envs) {
    const opened = time(env.createdAt);
    if (opened === null) continue;
    const closed = env.status === "destroyed" ? (time(env.destroyedAt) ?? opened) : now;
    if (closed < start || opened > now) continue;
    points.push({ at: Math.max(opened, start), delta: 1 }, { at: Math.min(closed, now), delta: -1 });
  }
  // A removal and an opening at the same instant don't overlap, so count the removal first.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  let peakAt: number | null = null;
  for (const point of points) {
    current += point.delta;
    if (current > peak) {
      peak = current;
      peakAt = point.at;
    }
  }

  return {
    awakeNow,
    asleepNow,
    burnPerHour: live
      .filter((env) => env.sleep === "awake" || env.sleep === "waking")
      .reduce((sum, env) => sum + hourlyRate(env, costPerHour), 0),
    created,
    peak,
    peakAt: peakAt === null ? null : new Date(peakAt).toISOString(),
    removed: removedList.length,
    reasons,
    automaticShare: removedList.length ? automatic / removedList.length : null,
    averageLifespanMs: average,
    medianLifespanMs: median,
    lifespanCount: lifespans.length,
  };
}

/** "45 min", "6.2 h", "3.4 days". */
export function formatLifespan(ms: number) {
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export const REMOVAL_LABELS: Record<DestroyReason, string> = {
  merged: "PR merged",
  closed: "PR closed",
  expired: "Time ran out",
  manual: "Removed by admin",
  idle: "Not used",
  failed: "Build failed",
  stuck: "Build got stuck",
  budget: "Budget reached",
};
