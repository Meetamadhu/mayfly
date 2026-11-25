import type { Environment } from "./types";
import { activityEvents } from "./activity";
import { removedBecause, timelineLabel } from "./timeline";

/**
 * The Admin page's "Recent activity" sheet: every preview's events plus the comments Mayfly posted on pull
 * requests, as short rows ("acme/web #12 · Updated"), grouped into Just now / Today / Earlier, with unread dots
 * remembered on this device.
 */

export type RecentKind = "visit" | "update" | "created" | "failed" | "asleep" | "time" | "removed" | "note";
export type RecentTab = "all" | "visits" | "updates" | "removed";

export const RECENT_TABS: { id: RecentTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "visits", label: "Visits" },
  { id: "updates", label: "Updates" },
  { id: "removed", label: "Removed" },
];

export type RecentItem = {
  key: string;
  at: string;
  envId: string;
  subject: string;
  kind: RecentKind;
  label: string;
  detail: string | null;
};

const MAX_ITEMS = 60;

/** The first line of a PR comment, without Markdown: "**Mayfly preview ready**: [open](…)" → "Mayfly preview ready". */
export function noteText(body: string) {
  const line =
    body
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("<!--")) ?? "";
  const plain = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\s:–—-]+$/, "")
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 77).trimEnd()}…` : plain;
}

function describe(type: string, detail: string | null | undefined): { kind: RecentKind; label: string; detail: string | null } {
  switch (type) {
    case "opened":
      return { kind: "created", label: "Created", detail: null };
    case "build_started":
      return { kind: "update", label: "Building", detail: null };
    case "built":
      return { kind: "update", label: "Built", detail: detail ? `in ${detail} s` : null };
    case "ready":
      return { kind: "update", label: "Ready", detail: null };
    case "updated":
      return { kind: "update", label: "Updated", detail: detail ? `new commit ${detail}` : null };
    case "failed":
      return { kind: "failed", label: "Build failed", detail: detail?.split("\n")[0]?.trim() || null };
    case "woke":
      return { kind: "visit", label: "Visit", detail: detail ? `woke up in ${detail} s` : "woke it up" };
    case "visited":
      return { kind: "visit", label: "Visit", detail: null };
    case "slept":
      return { kind: "asleep", label: "Fell asleep", detail: "no visitors" };
    case "destroyed":
      return { kind: "removed", label: "Removed", detail: detail ? removedBecause(detail) : null };
    case "feedback":
      return { kind: "note", label: "Feedback", detail: detail ? `from ${detail}` : null };
    default:
      return { kind: "time", label: timelineLabel({ at: "", type, detail: detail ?? undefined }), detail: null };
  }
}

export function recentItems(environments: Environment[], demoKey: string | null): RecentItem[] {
  const subjectOf = (env: Environment) =>
    `${env.repository}#${env.prNumber}` === demoKey ? "Demo preview" : `${env.repository} #${env.prNumber}`;
  const items: RecentItem[] = activityEvents(environments).map((event, index) => ({
    key: `${event.env.id}:${event.at}:${event.type}:${index}`,
    at: event.at,
    envId: event.env.id,
    subject: subjectOf(event.env),
    ...describe(event.type, event.detail),
  }));
  for (const env of environments) {
    (env.comments ?? []).forEach((comment, index) => {
      const text = noteText(comment.body);
      if (!text) return;
      items.push({
        key: `${env.id}:note:${comment.at}:${index}`,
        at: comment.at,
        envId: env.id,
        subject: subjectOf(env),
        kind: "note",
        label: "Note",
        detail: `“${text}”`,
      });
    });
  }
  return items
    .filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_ITEMS);
}

export function inTab(item: RecentItem, tab: RecentTab) {
  if (tab === "all") return true;
  if (tab === "visits") return item.kind === "visit";
  if (tab === "removed") return item.kind === "removed";
  return item.kind === "update" || item.kind === "created" || item.kind === "failed" || item.kind === "note";
}

/** "Just now" (last 15 minutes), "Today" (viewer's day) or "Earlier". */
export function recentGroup(at: string, now: number) {
  const ms = Date.parse(at);
  if (now - ms < 15 * 60 * 1000) return "Just now";
  return new Date(ms).toDateString() === new Date(now).toDateString() ? "Today" : "Earlier";
}

/** "now", "1m", "2h 1m", "3d". */
export function shortAgo(at: string, now: number) {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Read / unread, per device ──────────────────────────────────────────────────────────────────────────────────

export const READ_KEY = "mayfly-activity-read-at";

/** Until the first "Mark all read", the last day's items count as new. */
export function readSince(stored: string | null, now: number) {
  const ms = stored ? Date.parse(stored) : NaN;
  return Number.isFinite(ms) ? ms : now - 24 * 60 * 60 * 1000;
}

export function isUnread(item: RecentItem, readMs: number) {
  return Date.parse(item.at) > readMs;
}
