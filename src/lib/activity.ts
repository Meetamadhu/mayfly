import type { Environment, UsageDay } from "./types";
import { removedBecause, timelineLabel, timelineNewestFirst } from "./timeline";

/**
 * The Activity page's wording and numbers, kept apart from React so they can be tested: which kind each event is,
 * how a row reads ("Built #44 New onboarding flow" / "acme/web · 14 s"), the "Today so far" counts and the
 * awake/asleep hours per day for the chart.
 */

export type ActivityKind = "build" | "wake" | "nap" | "time" | "removed";
export type ActivityTab = "all" | ActivityKind;

export const ACTIVITY_TABS: { id: ActivityTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "build", label: "Builds" },
  { id: "wake", label: "Wakes" },
  { id: "nap", label: "Naps" },
  { id: "time", label: "Extended" },
  { id: "removed", label: "Removed" },
];

export function activityKind(type: string): ActivityKind {
  switch (type) {
    case "woke":
    case "visited":
      return "wake";
    case "slept":
      return "nap";
    case "destroyed":
      return "removed";
    case "extended":
    case "keep_awake":
    case "keep_awake_off":
    case "kept":
    case "unkept":
    case "warned":
      return "time";
    default:
      return "build";
  }
}

/** The icon tone for a row: the same four state colours as the Previews page, plus red for failures. */
export function activityTone(type: string): "building" | "awake" | "asleep" | "failed" | "time" {
  if (type === "woke" || type === "visited" || type === "ready") return "awake";
  if (type === "slept") return "asleep";
  if (type === "failed" || type === "destroyed") return "failed";
  if (activityKind(type) === "time") return "time";
  return "building";
}

export type ActivityEvent = { at: string; type: string; detail?: string | null; env: Environment };
export type ActivityRow = { at: string; type: string; detail?: string | null; envs: Environment[] };

const BURST_MS = 2 * 60 * 1000;

/**
 * Every preview's events, newest first. A build reads as one row: "Started building" is left out once the build
 * finished or failed, and "Ready to view" is left out right after "Finished building".
 */
export function activityEvents(environments: Environment[], keep: (env: Environment) => boolean = () => true) {
  const out: ActivityEvent[] = [];
  for (const env of environments) {
    if (!keep(env)) continue;
    const events = timelineNewestFirst(env.events);
    events.forEach((event, index) => {
      const newer = events[index - 1];
      const older = events[index + 1];
      if (event.type === "ready" && older?.type === "built") return;
      if (event.type === "build_started" && (newer?.type === "built" || newer?.type === "failed")) return;
      out.push({ at: event.at, type: event.type, detail: event.detail ?? null, env });
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Several previews sleeping or waking together (after a restart, say) read as one row. */
export function groupBursts(events: ActivityEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (let i = 0; i < events.length; ) {
    const first = events[i];
    let j = i + 1;
    if (first.type === "slept" || first.type === "woke") {
      while (j < events.length && events[j].type === first.type && Date.parse(first.at) - Date.parse(events[j].at) <= BURST_MS) {
        j += 1;
      }
    }
    rows.push({ at: first.at, type: first.type, detail: first.detail, envs: events.slice(i, j).map((item) => item.env) });
    i = j;
  }
  return rows;
}

function minutesText(seconds: number) {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

function clockText(iso: string) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayText(iso: string) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const REMOVED_TITLE: Record<string, string> = {
  merged: "removed after merge",
  closed: "removed after the PR closed",
  expired: "removed when its time ran out",
  manual: "removed by an admin",
  idle: "removed, nobody used it",
  failed: "removed, its build failed",
  stuck: "removed, its build got stuck",
  budget: "removed, it reached its budget",
};

export type RowText = { subject: string; before: string; after: string; sub: string };

/**
 * One row's words. The subject ("#44", or "Demo") is a button on the page, so the title is split around it:
 * `${before}${subject}${after}`.
 */
export function describeRow(row: ActivityRow, options: { demoKey: string | null; fallbackSleepSeconds: number }): RowText {
  const isDemo = (env: Environment) => `${env.repository}#${env.prNumber}` === options.demoKey;
  if (row.envs.length > 1) {
    const list = row.envs.map((env) => (isDemo(env) ? "Demo" : `#${env.prNumber}`)).join(", ");
    return {
      subject: `${row.envs.length} previews`,
      before: "",
      after: row.type === "slept" ? " went to sleep" : " woke up",
      sub: list,
    };
  }
  const env = row.envs[0];
  const demo = isDemo(env);
  const subject = demo ? "Demo" : `#${env.prNumber}`;
  const title = !demo && env.title ? ` ${env.title}` : "";
  const repo = demo ? "demo" : env.repository;
  const where = demo ? "demo" : `${env.repository} · ${env.branch}`;
  const by = !demo && env.author ? `PR by @${env.author}` : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const detail = row.detail ?? "";

  switch (row.type) {
    case "opened":
      return { subject, before: "Opened ", after: title, sub: join(where, by) };
    case "build_started":
      return { subject, before: "Building ", after: title, sub: where };
    case "built":
      return { subject, before: "Built ", after: title, sub: join(repo, detail ? `${detail} s` : "") };
    case "ready":
      return { subject, before: "", after: " is ready to view", sub: repo };
    case "updated":
      return { subject, before: "New commit on ", after: title, sub: join(repo, detail) };
    case "failed": {
      const first = detail.split("\n")[0]?.trim() ?? "";
      return { subject, before: "", after: " couldn’t build", sub: join(repo, first) };
    }
    case "woke":
      return {
        subject,
        before: "",
        after: demo ? " woke for a visitor" : " woke for a reviewer",
        sub: join(detail ? `Ready in ${detail} s` : "", by) || repo,
      };
    case "visited":
      return { subject, before: "", after: " was visited", sub: join(repo, by) };
    case "slept":
      return {
        subject,
        before: "",
        after: " went to sleep",
        sub: `No visits for ${minutesText(env.sleepSeconds ?? options.fallbackSleepSeconds)}`,
      };
    case "destroyed": {
      const reason = detail || env.destroyReason || "";
      return {
        subject,
        before: "",
        after: ` ${REMOVED_TITLE[reason] ?? "removed"}`,
        sub: reason === "manual" ? "Removed by hand" : reason ? `Cleaned up automatically: ${removedBecause(reason)}` : repo,
      };
    }
    case "extended":
      return { subject, before: "", after: detail ? ` extended to ${dayText(detail)}` : " extended", sub: repo };
    case "keep_awake":
      return { subject, before: "", after: detail ? ` kept awake until ${clockText(detail)}` : " kept awake", sub: repo };
    case "keep_awake_off":
      return { subject, before: "", after: " can sleep again", sub: repo };
    case "kept":
      return { subject, before: "", after: " kept open by a label", sub: join(repo, detail ? `“${detail}”` : "") };
    case "unkept":
      return { subject, before: "", after: " keep label removed", sub: join(repo, "lifetime restarted") };
    case "warned":
      return { subject, before: "", after: " expiry warning posted", sub: join(repo, "on the pull request") };
    default:
      return { subject, before: "", after: `: ${timelineLabel({ at: row.at, type: row.type, detail: row.detail ?? undefined }).toLowerCase()}`, sub: repo };
  }
}

/** "Today", "Yesterday" or "Mon 21 Nov", in the viewer's time zone. */
export function dayHeading(iso: string, now: number) {
  const day = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(day, new Date(now))) return "Today";
  if (same(day, new Date(now - 86_400_000))) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Today's rows show "2 min ago"; older ones show the clock time. */
export function rowTime(iso: string, now: number) {
  if (dayHeading(iso, now) !== "Today") return clockText(iso);
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** How many builds, wakes, naps and removals happened today (viewer's day), counting each event once. */
export function todayCounts(events: ActivityEvent[], now: number) {
  const counts = { build: 0, wake: 0, nap: 0, removed: 0 };
  for (const event of events) {
    if (dayHeading(event.at, now) !== "Today") continue;
    if (event.type === "built" || event.type === "failed") counts.build += 1;
    else if (event.type === "woke") counts.wake += 1;
    else if (event.type === "slept") counts.nap += 1;
    else if (event.type === "destroyed") counts.removed += 1;
  }
  return counts;
}

export type HoursDay = { key: string; label: string; awake: number; asleep: number };

/** Awake and asleep preview-hours for each of the last `count` UTC days, oldest first, today last. */
export function hoursPerDay(days: Record<string, UsageDay> | undefined, now: number, count = 7): HoursDay[] {
  const out: HoursDay[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const date = new Date(now - back * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const day = days?.[key];
    out.push({
      key,
      label: date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
      awake: (day?.awakeSeconds ?? 0) / 3600,
      asleep: (day?.asleepSeconds ?? 0) / 3600,
    });
  }
  return out;
}

/** A round top for a chart's axis: 1, 2, 5, 10, 20, 50, … times a power of ten, split into four steps. */
export function niceMax(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 4;
  const raw = value / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= raw) ?? 10 * power;
  return step * 4;
}
