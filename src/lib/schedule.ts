import { randomUUID } from "node:crypto";
import type { Environment } from "./types";

/**
 * Scheduled wake and sleep.
 *
 *  - Awake hours: "keep this repository's previews awake Monday to Friday, 09:00 to 18:00 in this time zone". The
 *    preview stays awake inside the window and goes back to its normal idle sleep when the window ends.
 *  - A pre-wake: one preview is started at a chosen time and kept awake for a while, so it's warm for a review.
 *
 * Nothing here talks to a preview. It works out what should be true now; automation.ts makes it so.
 */

export const MAX_WINDOWS = 30;
export const WAKE_MINUTES = { min: 15, max: 720 } as const;
export const MAX_WAKE_AHEAD_DAYS = 31;

export interface ScheduleWindow {
  id: string;
  /** owner/name in lower case, or "*" for every repository. */
  repository: string;
  /** 0 is Sunday, 6 is Saturday. */
  days: number[];
  /** 24-hour "HH:MM". The window never crosses midnight: start is before end. */
  start: string;
  end: string;
  /** An IANA name such as "Asia/Kolkata" or "Europe/London". */
  timezone: string;
}

export interface ScheduleSettings {
  windows: ScheduleWindow[];
  updatedAt: string | null;
}

export function defaultSchedules(): ScheduleSettings {
  return { windows: [], updatedAt: null };
}

export function isValidTimezone(zone: unknown): boolean {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function minutesOf(time: string) {
  const match = TIME_PATTERN.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The weekday (0 = Sunday) and minutes since midnight at this moment, in a time zone. */
export function localParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: WEEKDAYS[get("weekday")] ?? 0, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** When this window ends today, as a time in ms, if it's open at `now`; otherwise null. */
export function windowEndsAt(window: ScheduleWindow, now: number): number | null {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === null || end === null || !isValidTimezone(window.timezone)) return null;
  const local = localParts(now, window.timezone);
  if (!window.days.includes(local.day)) return null;
  if (local.minutes < start || local.minutes >= end) return null;
  // Whole minutes until the end, counted from the start of this minute.
  const minuteStart = now - (now % 60_000);
  return minuteStart + (end - local.minutes) * 60_000;
}

export function windowAppliesTo(window: ScheduleWindow, repository: string) {
  return window.repository === "*" || window.repository === repository.trim().toLowerCase();
}

/** The latest end among the windows that are open now for this repository, or null. */
export function openWindowEnd(windows: ScheduleWindow[], repository: string, now: number): number | null {
  let latest: number | null = null;
  for (const window of windows) {
    if (!windowAppliesTo(window, repository)) continue;
    const ends = windowEndsAt(window, now);
    if (ends !== null && (latest === null || ends > latest)) latest = ends;
  }
  return latest;
}

export interface ScheduleDecision {
  /** Keep the preview awake until this time (ms), because a window or a pre-wake covers now. */
  holdUntil: number | null;
  /** A pre-wake has just come due. */
  startWake: boolean;
  /** A pre-wake is over and can be forgotten. */
  clearWake: boolean;
}

export function scheduleDecision(
  env: Pick<Environment, "repository" | "scheduledWake">,
  windows: ScheduleWindow[],
  now: number,
): ScheduleDecision {
  let holdUntil = openWindowEnd(windows, env.repository, now);
  let startWake = false;
  let clearWake = false;
  const wake = env.scheduledWake;
  if (wake) {
    const at = Date.parse(wake.at);
    const until = at + wake.minutes * 60_000;
    if (!Number.isFinite(at)) clearWake = true;
    else if (now >= until) clearWake = true;
    else if (now >= at) {
      startWake = !wake.startedAt;
      holdUntil = holdUntil === null ? until : Math.max(holdUntil, until);
    }
  }
  return { holdUntil, startWake, clearWake };
}

/**
 * What the gate should hold the preview awake until: the later of a person's keep-awake and what the schedule
 * asks for, as an ISO time. Null when neither is in the future.
 */
export function effectiveHold(env: Pick<Environment, "keepAwakeUntil" | "scheduleHoldUntil">, now = Date.now()): string | null {
  let latest = 0;
  for (const value of [env.keepAwakeUntil, env.scheduleHoldUntil]) {
    const at = value ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && at > now && at > latest) latest = at;
  }
  return latest ? new Date(latest).toISOString() : null;
}

export type ScheduleParse = { ok: true; settings: ScheduleSettings } | { ok: false; error: string };

/** Check the awake hours sent from the page. Nothing is clamped: every window must be valid. */
export function parseSchedules(input: unknown, now = new Date().toISOString()): ScheduleParse {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the schedules as JSON." };
  const list = (input as { windows?: unknown }).windows ?? [];
  if (!Array.isArray(list)) return { ok: false, error: "Awake hours must be a list." };
  if (list.length > MAX_WINDOWS) return { ok: false, error: `Keep it to ${MAX_WINDOWS} awake-hours rules.` };
  const windows: ScheduleWindow[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each rule needs a repository, days and times." };
    const item = entry as Record<string, unknown>;
    const repository = typeof item.repository === "string" ? item.repository.trim().toLowerCase() : "";
    if (repository !== "*" && !REPO_PATTERN.test(repository)) {
      return { ok: false, error: `“${String(item.repository ?? "").slice(0, 80)}” is not owner/name (or * for all).` };
    }
    const days = Array.isArray(item.days) ? [...new Set(item.days)].sort() : null;
    if (!days || days.length === 0 || days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) {
      return { ok: false, error: `${repository}: choose at least one day.` };
    }
    const start = typeof item.start === "string" ? item.start.trim() : "";
    const end = typeof item.end === "string" ? item.end.trim() : "";
    const startMinutes = minutesOf(start);
    const endMinutes = minutesOf(end);
    if (startMinutes === null || endMinutes === null) return { ok: false, error: `${repository}: times look like 09:00.` };
    if (startMinutes >= endMinutes) {
      return { ok: false, error: `${repository}: the end must be after the start. For overnight hours, add two rules.` };
    }
    const timezone = typeof item.timezone === "string" ? item.timezone.trim() : "";
    if (!isValidTimezone(timezone)) return { ok: false, error: `${repository}: “${timezone.slice(0, 40)}” isn't a time zone (try Asia/Kolkata or UTC).` };
    const id = typeof item.id === "string" && /^[\w-]{8,64}$/.test(item.id) ? item.id : randomUUID();
    windows.push({ id, repository, days: days as number[], start, end, timezone });
  }
  return { ok: true, settings: { windows, updatedAt: now } };
}

export function asSchedules(value: unknown): ScheduleSettings | undefined {
  const updatedAt = (value as { updatedAt?: unknown } | null | undefined)?.updatedAt;
  const parsed = parseSchedules(value, typeof updatedAt === "string" ? updatedAt : undefined);
  return parsed.ok && parsed.settings.windows.length > 0 ? parsed.settings : undefined;
}

export type WakeParse = { ok: true; wake: { at: string; minutes: number; startedAt: null } } | { ok: false; error: string };

/** Check a pre-wake: a time from now to a month away, and how long to stay awake. */
export function parseWake(input: unknown, now = Date.now()): WakeParse {
  if (!input || typeof input !== "object") return { ok: false, error: "Send the wake time as JSON." };
  const body = input as Record<string, unknown>;
  const at = typeof body.at === "string" ? Date.parse(body.at) : NaN;
  if (!Number.isFinite(at)) return { ok: false, error: "Choose when to wake the preview." };
  if (at < now - 60_000) return { ok: false, error: "That time has already passed." };
  if (at > now + MAX_WAKE_AHEAD_DAYS * 86_400_000) return { ok: false, error: `Choose a time within the next ${MAX_WAKE_AHEAD_DAYS} days.` };
  const raw = body.minutes ?? 60;
  const minutes = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < WAKE_MINUTES.min || minutes > WAKE_MINUTES.max) {
    return { ok: false, error: `Stay awake for ${WAKE_MINUTES.min} to ${WAKE_MINUTES.max} minutes.` };
  }
  return { ok: true, wake: { at: new Date(at).toISOString(), minutes, startedAt: null } };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon to Fri, 09:00 to 18:00 (Asia/Kolkata)" */
export function describeWindow(window: ScheduleWindow) {
  const days = window.days;
  const run = days.length > 1 && days.every((day, index) => index === 0 || day === days[index - 1] + 1);
  const names = run ? `${DAY_NAMES[days[0]]} to ${DAY_NAMES[days[days.length - 1]]}` : days.map((day) => DAY_NAMES[day]).join(", ");
  return `${names}, ${window.start} to ${window.end} (${window.timezone})`;
}
