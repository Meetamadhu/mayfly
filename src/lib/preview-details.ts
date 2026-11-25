import type { Environment } from "./types";

/**
 * The Preview details panel's status card: what the preview is doing, a line under it ("sleeps in 18 min"), and
 * how full the bar is. Kept apart from React so it can be tested.
 */

export type DetailState = "awake" | "kept" | "asleep" | "building" | "failed" | "removing" | "removed";

export type StatusCard = {
  state: DetailState;
  label: string;
  line: string;
  /** 0–1 for the bar, or null when there is no bar. */
  progress: number | null;
};

const MIN = 60_000;

function time(value: string | null | undefined) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function inMinutes(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / MIN));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function detailState(env: Environment, now: number): DetailState {
  if (env.status === "destroyed") return "removed";
  if (env.status === "destroying") return "removing";
  if (env.status === "failed") return "failed";
  if (env.status === "provisioning" || env.status === "updating") return "building";
  if (env.sleep === "asleep") return "asleep";
  const kept = time(env.keepAwakeUntil);
  if (kept !== null && kept > now) return "kept";
  return "awake";
}

/** How long the last build took, in ms: the preview's own record, or the latest "built" event. */
export function lastBuildMs(env: Environment) {
  if (typeof env.buildMs === "number" && env.buildMs > 0) return env.buildMs;
  const built = [...(env.events ?? [])].reverse().find((event) => event.type === "built" && event.detail);
  const seconds = Number(built?.detail);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export function statusCard(
  env: Environment,
  now: number,
  options: { fallbackSleepSeconds: number; usualBuildMs: number | null },
): StatusCard {
  const state = detailState(env, now);
  switch (state) {
    case "awake": {
      const idleMs = (env.sleepSeconds ?? options.fallbackSleepSeconds) * 1000;
      const last = time(env.lastActiveAt) ?? now;
      const left = last + idleMs - now;
      return {
        state,
        label: "Awake",
        line: left > 0 ? `sleeps in ${inMinutes(left)} if nobody visits` : "going to sleep now",
        progress: idleMs > 0 ? Math.min(1, Math.max(0, left / idleMs)) : null,
      };
    }
    case "kept": {
      const until = time(env.keepAwakeUntil)!;
      const from = [...(env.events ?? [])].reverse().find((event) => event.type === "keep_awake");
      const start = time(from?.at) ?? now;
      const span = until - start;
      return {
        state,
        label: "Kept awake",
        line: `until ${clock(until)}, ${inMinutes(until - now)} from now`,
        progress: span > 0 ? Math.min(1, Math.max(0, (until - now) / span)) : null,
      };
    }
    case "asleep":
      return { state, label: "Asleep", line: "wakes in a few seconds on the next visit", progress: null };
    case "building": {
      const started = [...(env.events ?? [])].reverse().find((event) => event.type === "build_started");
      const begin = time(started?.at) ?? time(env.updatedAt) ?? now;
      const usual = options.usualBuildMs;
      if (!usual) return { state, label: "Building", line: "this takes a moment", progress: null };
      const done = now - begin;
      const left = usual - done;
      return {
        state,
        label: "Building",
        line: left > 1000 ? `about ${Math.ceil(left / 1000)} s left` : "almost done",
        progress: Math.min(0.95, Math.max(0.05, done / usual)),
      };
    }
    case "failed":
      return { state, label: "Couldn’t build", line: "push a fix to the pull request to try again", progress: null };
    case "removing":
      return { state, label: "Removing", line: "the link stops working in a moment", progress: null };
    case "removed":
      return { state, label: "Removed", line: removedLine(env), progress: null };
  }
}

function removedLine(env: Environment) {
  const when = time(env.destroyedAt);
  const day = when === null ? "" : ` on ${new Date(when).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  switch (env.destroyReason) {
    case "merged":
      return `after the pull request was merged${day}`;
    case "closed":
      return `after the pull request was closed${day}`;
    case "expired":
      return `when its time ran out${day}`;
    case "manual":
      return `by an admin${day}`;
    case "budget":
      return `when it reached its budget${day}`;
    default:
      return day ? day.trim() : "this preview no longer runs";
  }
}

/** "4 min", "2 h 5 min", "3 days": how long something has been, or will be. */
export function spanText(ms: number) {
  if (!Number.isFinite(ms)) return "–";
  const abs = Math.abs(ms);
  if (abs < MIN) return "under a minute";
  if (abs < 48 * 60 * MIN) return inMinutes(abs);
  return `${Math.round(abs / (24 * 60 * MIN))} days`;
}

/** "in 2 days", "in 3 h", "ended". */
export function endsText(env: Environment, now: number) {
  const ends = time(env.expiresAt);
  if (ends === null) return "–";
  if (ends <= now) return "any moment now";
  return `in ${spanText(ends - now)}`;
}

/** The address bar keeps ?preview=<id> while the panel is open, so the view can be shared or reloaded. */
export const PREVIEW_PARAM = "preview";

export function previewIdFromSearch(search: string) {
  const id = new URLSearchParams(search).get(PREVIEW_PARAM);
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** The typical build time across previews (the median of their last builds), for the "about 14 s left" estimate. */
export function usualBuildMs(environments: Environment[]) {
  const times = environments.map((env) => env.buildMs).filter((ms): ms is number => typeof ms === "number" && ms > 0);
  if (times.length === 0) return null;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
