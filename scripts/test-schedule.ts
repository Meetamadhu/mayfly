/**
 * Awake hours and pre-wakes: which windows are open (in the window's own time zone), what a preview should be
 * held awake until, and what the gate is told. Run with: npx tsx scripts/test-schedule.ts
 */
import assert from "node:assert/strict";
import {
  asSchedules,
  describeWindow,
  effectiveHold,
  openWindowEnd,
  parseSchedules,
  parseWake,
  scheduleDecision,
  windowEndsAt,
  type ScheduleWindow,
} from "../src/lib/schedule";

const at = (iso: string) => Date.parse(iso);
const weekdays: ScheduleWindow = { id: "w1-aaaaaa", repository: "acme/web", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", timezone: "Asia/Kolkata" };

// Monday 2026-11-23, 10:30 in Kolkata is 05:00 UTC. The window ends at 18:00 Kolkata = 12:30 UTC.
assert.equal(windowEndsAt(weekdays, at("2026-11-23T05:00:00Z")), at("2026-11-23T12:30:00Z"));
// Before it opens (08:59 Kolkata) and exactly at the end (18:00) it's closed.
assert.equal(windowEndsAt(weekdays, at("2026-11-23T03:29:00Z")), null);
assert.equal(windowEndsAt(weekdays, at("2026-11-23T03:30:00Z")), at("2026-11-23T12:30:00Z"));
assert.equal(windowEndsAt(weekdays, at("2026-11-23T12:30:00Z")), null);
// Saturday and Sunday are closed.
assert.equal(windowEndsAt(weekdays, at("2026-11-28T05:00:00Z")), null);
assert.equal(windowEndsAt(weekdays, at("2026-11-29T05:00:00Z")), null);
// The day is the one in the window's time zone: 23:00 UTC Sunday is already Monday 04:30 in Kolkata (closed, too early),
// but 04:00 UTC Monday is 09:30 there.
assert.equal(windowEndsAt(weekdays, at("2026-11-29T23:00:00Z")), null);
assert.ok(windowEndsAt(weekdays, at("2026-11-30T04:00:00Z")) !== null);
// Another zone, across the date line from UTC: Los Angeles Monday 09:00 is 17:00 UTC (winter).
const la: ScheduleWindow = { ...weekdays, timezone: "America/Los_Angeles" };
assert.ok(windowEndsAt(la, at("2026-11-23T17:00:00Z")) !== null);
assert.equal(windowEndsAt(la, at("2026-11-23T16:59:00Z")), null);

// Which repositories a window covers.
const all: ScheduleWindow = { ...weekdays, id: "w2-bbbbbb", repository: "*", start: "09:00", end: "10:00" };
const during = at("2026-11-23T05:00:00Z");
assert.equal(openWindowEnd([weekdays], "ACME/Web", during), at("2026-11-23T12:30:00Z"), "repository names are not case sensitive");
assert.equal(openWindowEnd([weekdays], "acme/api", during), null);
assert.equal(openWindowEnd([weekdays, all], "acme/api", at("2026-11-23T04:00:00Z")), at("2026-11-23T04:30:00Z"), "* covers everything");
// Overlapping windows hold until the later end.
assert.equal(openWindowEnd([weekdays, all], "acme/web", at("2026-11-23T04:00:00Z")), at("2026-11-23T12:30:00Z"));

// What to do for a preview.
const env = { repository: "acme/web", scheduledWake: null as null | { at: string; minutes: number; startedAt?: string | null } };
assert.deepEqual(scheduleDecision(env, [weekdays], at("2026-11-23T05:00:00Z")), { holdUntil: at("2026-11-23T12:30:00Z"), startWake: false, clearWake: false });
assert.equal(scheduleDecision(env, [weekdays], at("2026-11-28T05:00:00Z")).holdUntil, null);
// A pre-wake: nothing before its time, a start at its time, held until it ends, then cleared.
const wake = { at: "2026-11-28T09:00:00Z", minutes: 60 };
const withWake = { ...env, scheduledWake: wake };
assert.deepEqual(scheduleDecision(withWake, [], at("2026-11-28T08:59:00Z")), { holdUntil: null, startWake: false, clearWake: false });
assert.deepEqual(scheduleDecision(withWake, [], at("2026-11-28T09:00:30Z")), { holdUntil: at("2026-11-28T10:00:00Z"), startWake: true, clearWake: false });
const started = { ...env, scheduledWake: { ...wake, startedAt: "2026-11-28T09:00:30Z" } };
assert.equal(scheduleDecision(started, [], at("2026-11-28T09:30:00Z")).startWake, false, "started once");
assert.equal(scheduleDecision(started, [], at("2026-11-28T09:30:00Z")).holdUntil, at("2026-11-28T10:00:00Z"));
assert.equal(scheduleDecision(started, [], at("2026-11-28T10:00:00Z")).clearWake, true);
// A pre-wake inside a window holds until the later of the two.
assert.equal(scheduleDecision({ ...env, scheduledWake: { at: "2026-11-23T05:00:00Z", minutes: 720 } }, [weekdays], at("2026-11-23T05:30:00Z")).holdUntil, at("2026-11-23T17:00:00Z"));

// What the gate is told: the later of a person's keep-awake and the schedule's hold.
const now = at("2026-11-23T05:00:00Z");
assert.equal(effectiveHold({ keepAwakeUntil: null, scheduleHoldUntil: null }, now), null);
assert.equal(effectiveHold({ keepAwakeUntil: "2026-11-23T06:00:00Z", scheduleHoldUntil: null }, now), "2026-11-23T06:00:00.000Z");
assert.equal(effectiveHold({ keepAwakeUntil: "2026-11-23T06:00:00Z", scheduleHoldUntil: "2026-11-23T12:30:00Z" }, now), "2026-11-23T12:30:00.000Z");
assert.equal(effectiveHold({ keepAwakeUntil: "2026-11-22T06:00:00Z", scheduleHoldUntil: "2026-11-22T12:30:00Z" }, now), null, "past times don't count");

// Checking what the page sends.
const good = parseSchedules({ windows: [{ repository: "Acme/Web", days: [5, 1, 1, 3], start: "09:00", end: "17:30", timezone: "Europe/London" }] }, "2026-11-01T00:00:00.000Z");
assert.ok(good.ok);
if (good.ok) {
  assert.equal(good.settings.windows[0].repository, "acme/web");
  assert.deepEqual(good.settings.windows[0].days, [1, 3, 5]);
  assert.match(good.settings.windows[0].id, /^[\w-]{8,64}$/);
}
const bad = (window: Record<string, unknown>) => parseSchedules({ windows: [{ repository: "acme/web", days: [1], start: "09:00", end: "10:00", timezone: "UTC", ...window }] });
assert.ok(bad({}).ok);
assert.ok(!bad({ repository: "nonsense" }).ok);
assert.ok(bad({ repository: "*" }).ok);
assert.ok(!bad({ days: [] }).ok);
assert.ok(!bad({ days: [7] }).ok);
assert.ok(!bad({ start: "9am" }).ok);
assert.ok(!bad({ start: "10:00", end: "09:00" }).ok, "overnight windows are two rules");
assert.ok(!bad({ start: "10:00", end: "10:00" }).ok);
assert.ok(!bad({ timezone: "Mars/Olympus" }).ok);
assert.ok(!parseSchedules({ windows: Array.from({ length: 31 }, () => ({ repository: "*", days: [1], start: "09:00", end: "10:00", timezone: "UTC" })) }).ok);
assert.ok(!parseSchedules("x").ok);
assert.equal(asSchedules({ windows: [] }), undefined);
assert.equal(asSchedules({ windows: [{ repository: "acme/web", days: [1], start: "09:00", end: "10:00", timezone: "UTC" }] })?.windows.length, 1);

assert.equal(describeWindow(weekdays), "Mon to Fri, 09:00 to 18:00 (Asia/Kolkata)");
assert.equal(describeWindow({ ...weekdays, days: [0, 6] }), "Sun, Sat, 09:00 to 18:00 (Asia/Kolkata)");

// Pre-wake input.
const t0 = at("2026-11-23T05:00:00Z");
const okWake = parseWake({ at: "2026-11-24T09:00:00Z", minutes: 90 }, t0);
assert.ok(okWake.ok && okWake.wake.minutes === 90 && okWake.wake.startedAt === null);
assert.ok(parseWake({ at: "2026-11-24T09:00:00Z" }, t0).ok, "defaults to an hour");
assert.ok(!parseWake({ at: "2026-11-20T09:00:00Z" }, t0).ok, "not in the past");
assert.ok(!parseWake({ at: "2027-03-01T09:00:00Z" }, t0).ok, "not more than a month away");
assert.ok(!parseWake({ at: "2026-11-24T09:00:00Z", minutes: 5 }, t0).ok);
assert.ok(!parseWake({ at: "2026-11-24T09:00:00Z", minutes: 900 }, t0).ok);
assert.ok(!parseWake({ at: "soon" }, t0).ok);
assert.ok(!parseWake(null, t0).ok);

console.log("schedule: ok");
