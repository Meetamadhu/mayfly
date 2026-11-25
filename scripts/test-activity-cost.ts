/**
 * The redesigned Activity and Cost pages' logic: one row per build, burst grouping, row wording, today's counts,
 * hours per day, period totals, spend bars and the "Estimate your own" sums. Run with: npx tsx scripts/test-activity-cost.ts
 */
import assert from "node:assert/strict";
import type { Environment, EnvironmentEvent, UsageMonth } from "../src/lib/types";

async function main() {
  const activity = await import("../src/lib/activity");
  const cost = await import("../src/lib/cost-view");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const now = Date.parse("2026-11-23T12:00:00Z");
  const env = (over: Partial<Environment>): Environment =>
    ({
      id: Math.random().toString(36).slice(2),
      repository: "acme/web",
      prNumber: 44,
      sha: "a".repeat(40),
      branch: "ux/onboard",
      status: "ready",
      deploymentId: "d",
      url: "http://x/p/acme/web/44",
      createdAt: "2026-11-23T10:00:00Z",
      updatedAt: "2026-11-23T10:00:00Z",
      expiresAt: "2026-11-24T10:00:00Z",
      lastActiveAt: "2026-11-23T11:55:00Z",
      destroyedAt: null,
      destroyReason: null,
      error: null,
      updateGeneration: 1,
      comments: [],
      ...over,
    }) as Environment;
  const ev = (at: string, type: string, detail?: string): EnvironmentEvent => ({ at, type, ...(detail ? { detail } : {}) });
  const options = { demoKey: null, fallbackSleepSeconds: 1800 };

  check("a finished build is one row: 'started' and 'ready' are folded in", () => {
    const e = env({
      title: "New onboarding flow",
      events: [
        ev("2026-11-23T11:00:00Z", "opened"),
        ev("2026-11-23T11:00:01Z", "build_started"),
        ev("2026-11-23T11:00:15Z", "built", "14"),
        ev("2026-11-23T11:00:15Z", "ready"),
      ],
    });
    const types = activity.activityEvents([e]).map((item) => item.type);
    assert.deepEqual(types, ["built", "opened"]);
  });

  check("a build still running shows 'Building'", () => {
    const e = env({ events: [ev("2026-11-23T11:00:00Z", "opened"), ev("2026-11-23T11:00:01Z", "build_started")] });
    assert.deepEqual(activity.activityEvents([e]).map((item) => item.type), ["build_started", "opened"]);
  });

  check("several previews sleeping together read as one row", () => {
    const a = env({ prNumber: 1, events: [ev("2026-11-23T11:00:00Z", "slept")] });
    const b = env({ prNumber: 2, events: [ev("2026-11-23T11:01:00Z", "slept")] });
    const c = env({ prNumber: 3, events: [ev("2026-11-23T09:00:00Z", "slept")] });
    const rows = activity.groupBursts(activity.activityEvents([a, b, c]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].envs.length, 2);
    const text = activity.describeRow(rows[0], options);
    assert.equal(`${text.before}${text.subject}${text.after}`, "2 previews went to sleep");
    assert.equal(text.sub, "#2, #1");
  });

  check("row wording follows the design", () => {
    const e = env({ title: "New onboarding flow", author: "sam", sleepSeconds: 1800 });
    const say = (type: string, detail?: string) => {
      const text = activity.describeRow({ at: "2026-11-23T11:00:00Z", type, detail, envs: [e] }, options);
      return `${text.before}${text.subject}${text.after} | ${text.sub}`;
    };
    assert.equal(say("built", "14"), "Built #44 New onboarding flow | acme/web · 14 s");
    assert.equal(say("woke", "2"), "#44 woke for a reviewer | Ready in 2 s · PR by @sam");
    assert.equal(say("slept"), "#44 went to sleep | No visits for 30 min");
    assert.equal(say("destroyed", "merged"), "#44 removed after merge | Cleaned up automatically: the pull request was merged");
    assert.equal(say("destroyed", "manual"), "#44 removed by an admin | Removed by hand");
    assert.equal(say("failed", "npm ERR! missing script\nmore"), "#44 couldn’t build | acme/web · npm ERR! missing script");
  });

  check("the demo is called Demo, without a PR title", () => {
    const e = env({ repository: "mayfly/demo", prNumber: 1, title: "Should not show" });
    const text = activity.describeRow({ at: "2026-11-23T11:00:00Z", type: "built", detail: "3", envs: [e] }, { demoKey: "mayfly/demo#1", fallbackSleepSeconds: 1800 });
    assert.equal(`${text.before}${text.subject}${text.after}`, "Built Demo");
  });

  check("tabs: each event type lands in one tab", () => {
    assert.equal(activity.activityKind("built"), "build");
    assert.equal(activity.activityKind("failed"), "build");
    assert.equal(activity.activityKind("woke"), "wake");
    assert.equal(activity.activityKind("slept"), "nap");
    assert.equal(activity.activityKind("keep_awake"), "time");
    assert.equal(activity.activityKind("destroyed"), "removed");
  });

  check("today's counts only count today", () => {
    const today = new Date(now).toISOString().slice(0, 10);
    const e = env({
      events: [
        ev(`${today}T11:30:00Z`, "built", "9"),
        ev(`${today}T11:40:00Z`, "woke", "2"),
        ev(`${today}T11:50:00Z`, "slept"),
        ev("2026-11-20T10:00:00Z", "built", "9"),
      ],
    });
    const counts = activity.todayCounts(activity.activityEvents([e]), now);
    assert.deepEqual(counts, { build: 1, wake: 1, nap: 1, removed: 0 });
  });

  check("hours per day: last 7 UTC days, today last, missing days are zero", () => {
    const days = { "2026-11-23": { awakeSeconds: 7200, asleepSeconds: 3600 }, "2026-11-17": { awakeSeconds: 0, asleepSeconds: 36000 } };
    const out = activity.hoursPerDay(days, now, 7);
    assert.equal(out.length, 7);
    assert.equal(out[6].key, "2026-11-23");
    assert.equal(out[6].awake, 2);
    assert.equal(out[0].key, "2026-11-17");
    assert.equal(out[0].asleep, 10);
    assert.equal(out[3].awake + out[3].asleep, 0);
  });

  check("chart axis tops are round numbers", () => {
    assert.equal(activity.niceMax(0), 4);
    assert.equal(activity.niceMax(113), 200);
    assert.equal(activity.niceMax(19), 20);
    assert.equal(activity.niceMax(0.3), 0.4);
  });

  const usage: UsageMonth = {
    month: "2026-11",
    awakeSeconds: 100 * 3600,
    asleepSeconds: 300 * 3600,
    lastSampleAt: "2026-11-23T12:00:00Z",
    days: {
      "2026-11-23": { awakeSeconds: 3600, asleepSeconds: 7200 },
      "2026-11-17": { awakeSeconds: 3600, asleepSeconds: 3600 },
      "2026-11-16": { awakeSeconds: 99 * 3600, asleepSeconds: 0 },
      "2026-11-02": { awakeSeconds: 7200, asleepSeconds: 0 },
    },
  };

  check("period totals: the month uses the monthly total, the week the last 7 days", () => {
    assert.deepEqual(cost.periodSeconds(usage, "month", now), { awake: 360000, asleep: 1080000, awakeMoney: 360000, asleepMoney: 1080000 });
    assert.deepEqual(cost.periodSeconds(usage, "week", now), { awake: 7200, asleep: 10800, awakeMoney: 7200, asleepMoney: 10800 });
  });

  check("spend bars: 7 days for a week, weeks of the month for a month", () => {
    const week = cost.spendBars(usage, "week", 0.05, now);
    assert.equal(week.length, 7);
    assert.equal(week[6].always.toFixed(2), "0.15");
    assert.equal(week[6].mayfly.toFixed(2), "0.05");
    const month = cost.spendBars(usage, "month", 0.05, now);
    assert.deepEqual(month.map((bar) => bar.label), ["Wk 1", "Wk 2", "Wk 3", "Wk 4"]);
    assert.equal(month[0].always.toFixed(2), "0.10");
    assert.equal(month[2].mayfly.toFixed(2), "5.00");
    assert.equal(month[3].title.startsWith("22–28"), true);
  });

  check("previews and removals in the period", () => {
    const list = [
      env({}),
      env({ status: "destroyed", destroyedAt: "2026-11-20T00:00:00Z", destroyReason: "merged" }),
      env({ status: "destroyed", destroyedAt: "2026-11-21T00:00:00Z", destroyReason: "expired" }),
      env({ status: "destroyed", destroyedAt: "2026-10-20T00:00:00Z", destroyReason: "merged" }),
    ];
    const start = cost.periodStart("month", now);
    assert.equal(cost.previewsInPeriod(list, start, now), 3);
    assert.deepEqual(cost.removalsInPeriod(list, start), { total: 2, merged: 1 });
  });

  check("estimate: awake only for the hours people look", () => {
    const out = cost.estimateMonthly({ perWeek: 12, hoursAwake: 3, lifespanDays: 2, costPerHour: 0.05 });
    assert.equal(Math.round(out.always), 125);
    assert.equal(out.mayfly.toFixed(2), (out.always / 8).toFixed(2));
    assert.equal(cost.estimateMonthly({ perWeek: 12, hoursAwake: 30, lifespanDays: 2, costPerHour: 0.05 }).mayfly.toFixed(2), out.always.toFixed(2));
  });

  check("money and hours read short", () => {
    assert.equal(cost.formatMoneyShort(108.4), "$108");
    assert.equal(cost.formatMoneyShort(14.04), "$14.04");
    assert.equal(cost.formatMoneyShort(0), "$0");
    assert.equal(cost.formatHours(142 * 3600), "142 h");
    assert.equal(cost.formatHours(5400), "1.5 h");
    assert.equal(cost.formatHours(600), "10 min");
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
