import type { EnvironmentEvent } from "./types";

/** Shared lifecycle wording for the board drawer and the admin cards. */

function formatDay(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatClock(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const REMOVAL_REASONS: Record<string, string> = {
  closed: "PR closed",
  merged: "PR merged",
  expired: "lifetime ended",
  manual: "removed by an admin",
  stuck: "stuck",
  failed: "failed",
};

export function timelineLabel(event: EnvironmentEvent): string {
  switch (event.type) {
    case "opened":
      return "Pull request opened";
    case "build_started":
      return "Build started";
    case "built":
      return event.detail ? `Built in ${event.detail} s` : "Built";
    case "ready":
      return "Preview ready";
    case "updated":
      return event.detail ? `Updated to ${event.detail}` : "Updated";
    case "slept":
      return "Slept after no visits";
    case "woke":
      return event.detail ? `Woken by a visit (${event.detail} s)` : "Woken by a visit";
    case "extended":
      return event.detail ? `Extended to ${formatDay(event.detail)}` : "Extended";
    case "keep_awake":
      return event.detail ? `Kept awake until ${formatClock(event.detail)}` : "Kept awake";
    case "keep_awake_off":
      return "Stopped keeping awake";
    case "failed": {
      const first = event.detail?.split("\n")[0]?.trim();
      return first ? `Failed: ${first}` : "Failed";
    }
    case "destroyed": {
      const reason = event.detail ? (REMOVAL_REASONS[event.detail] ?? event.detail) : "";
      return reason ? `Removed (${reason})` : "Removed";
    }
    default:
      return event.detail ? `${event.type.replace(/_/g, " ")}: ${event.detail}` : event.type.replace(/_/g, " ");
  }
}

export type TimelineTone = "start" | "build" | "ready" | "sleep" | "wake" | "time" | "failed" | "removed";

export function timelineTone(type: string): TimelineTone {
  switch (type) {
    case "opened":
      return "start";
    case "build_started":
    case "built":
    case "updated":
      return "build";
    case "ready":
      return "ready";
    case "slept":
      return "sleep";
    case "woke":
      return "wake";
    case "extended":
    case "keep_awake":
    case "keep_awake_off":
      return "time";
    case "failed":
      return "failed";
    case "destroyed":
      return "removed";
    default:
      return "time";
  }
}

export function timelineNewestFirst(events: EnvironmentEvent[] | undefined) {
  if (!events?.length) return [];
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function timelineOldestFirst(events: EnvironmentEvent[] | undefined) {
  if (!events?.length) return [];
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function formatEventTime(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "< 1 min ago", "24 min ago", "6 h ago", "2 d ago". */
export function formatAgoRounded(iso: string, now: number) {
  const delta = now - Date.parse(iso);
  if (Number.isNaN(delta)) return iso;
  const abs = Math.abs(delta);
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 1) return "< 1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(abs / 86_400_000)} d ago`;
}
