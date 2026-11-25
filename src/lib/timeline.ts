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
  expired: "time ran out",
  manual: "removed by an admin",
  idle: "not used",
  stuck: "build got stuck",
  failed: "build failed",
  budget: "budget reached",
};

const REMOVED_BECAUSE: Record<string, string> = {
  merged: "the pull request was merged",
  closed: "the pull request was closed",
  expired: "its time ran out",
  manual: "an admin removed it",
  idle: "nobody was using it",
  failed: "its build failed",
  stuck: "its build got stuck",
  budget: "it reached its budget",
};

/** "the pull request was merged", for sentences like "This preview was removed because …". */
export function removedBecause(reason: string) {
  return REMOVED_BECAUSE[reason] ?? reason;
}

/** "Removed (PR merged)", "Removed (time ran out)", or plain "Removed". */
export function removedLabel(reason: string | null | undefined) {
  const words = reason ? (REMOVAL_REASONS[reason] ?? reason) : "";
  return words ? `Removed (${words})` : "Removed";
}

export function timelineLabel(event: EnvironmentEvent): string {
  switch (event.type) {
    case "opened":
      return "Pull request opened";
    case "build_started":
      return "Started building";
    case "built":
      return event.detail ? `Finished building in ${event.detail} s` : "Finished building";
    case "ready":
      return "Ready to view";
    case "updated":
      return event.detail ? `New commit ${event.detail}` : "New commit";
    case "slept":
      return "Fell asleep (no visitors)";
    case "woke":
      return event.detail ? `Woke up for a visitor (took ${event.detail} s)` : "Woke up for a visitor";
    case "visited":
      return "Visited";
    case "extended":
      return event.detail ? `Extended to ${formatDay(event.detail)}` : "Extended";
    case "keep_awake":
      return event.detail ? `Kept awake until ${formatClock(event.detail)}` : "Kept awake";
    case "keep_awake_off":
      return "Allowed to sleep again";
    case "kept":
      return event.detail ? `Kept open by the “${event.detail}” label` : "Kept open by a label";
    case "unkept":
      return "Keep label removed, lifetime restarted";
    case "warned":
      return "Expiry warning posted on the PR";
    case "feedback":
      return event.detail ? `Feedback from ${event.detail}` : "Feedback left on the preview";
    case "failed": {
      const first = event.detail?.split("\n")[0]?.trim();
      return first ? `Couldn’t build: ${first}` : "Couldn’t build";
    }
    case "destroyed": {
      return removedLabel(event.detail);
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
    case "visited":
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

/**
 * Oldest first, without restart noise: a "slept" right after another "slept" (nothing in between)
 * comes from Mayfly restarting, not from anyone using the preview.
 */
export function timelineOldestFirst(events: EnvironmentEvent[] | undefined) {
  if (!events?.length) return [];
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const kept: EnvironmentEvent[] = [];
  for (const event of sorted) {
    if (event.type === "slept" && kept[kept.length - 1]?.type === "slept") continue;
    kept.push(event);
  }
  return kept;
}

export function timelineNewestFirst(events: EnvironmentEvent[] | undefined) {
  return timelineOldestFirst(events).reverse();
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

/** Drop a "visited" noted within 2 minutes of a wake: the visit that woke a preview is recorded as the wake. */
export function withoutVisitNearWake(events: EnvironmentEvent[], wokeMs: number) {
  return events.filter((event) => !(event.type === "visited" && Math.abs(Date.parse(event.at) - wokeMs) <= 2 * 60 * 1000));
}
