/**
 * Per-repository and per-team cost reports, the CSV, and the weekly email's content and timing.
 * Run with: npx tsx scripts/test-cost-report.ts
 */
import assert from "node:assert/strict";
import { budgetStatus, defaultBudget } from "../src/lib/budget";
import { buildCostReport, csvCell, parseTeams, reportToCsv, teamFor, UNATTRIBUTED } from "../src/lib/cost-report";
import type { Environment, UsageMonth } from "../src/lib/types";
import { asReportState, buildWeeklySummary, isoWeek, recipientsFromEnv, reportScheduleFromEnv, weeklyDue } from "../src/lib/weekly-report";

const NOW = Date.parse("2026-11-26T12:00:00Z"); // a Thursday
const HOUR = 3600;
const usage: UsageMonth = {
  month: "2026-11",
  awakeSeconds: 0,
  asleepSeconds: 0,
  lastSampleAt: "2026-11-26T11:59:00Z",
  days: {
    // Before repositories were recorded: only the day's totals.
    "2026-11-18": { awakeSeconds: 2 * HOUR, asleepSeconds: 10 * HOUR },
    "2026-11-24": {
      awakeSeconds: 6 * HOUR,
      asleepSeconds: 30 * HOUR,
      repos: {
        "acme/web": { awakeSeconds: 4 * HOUR, asleepSeconds: 20 * HOUR },
        "acme/api": { awakeSeconds: 2 * HOUR, asleepSeconds: 10 * HOUR },
      },
    },
    "2026-11-26": {
      awakeSeconds: 3 * HOUR,
      asleepSeconds: 9 * HOUR,
      repos: {
        "acme/web": { awakeSeconds: 1 * HOUR, asleepSeconds: 3 * HOUR },
        "other/site": { awakeSeconds: 2 * HOUR, asleepSeconds: 6 * HOUR },
      },
    },
  },
};
const env = (repository: string, prNumber: number, createdAt: string, extra: Partial<Environment> = {}) =>
  ({ id: `${repository}#${prNumber}`, repository, prNumber, createdAt, status: "ready", destroyedAt: null, ...extra }) as Environment;
const environments = [
  env("acme/web", 1, "2026-11-10T00:00:00Z"),
  env("acme/web", 2, "2026-11-25T00:00:00Z"),
  env("acme/api", 3, "2026-11-24T00:00:00Z"),
  env("other/site", 4, "2026-11-26T00:00:00Z"),
  env("acme/old", 5, "2026-10-01T00:00:00Z", { status: "destroyed", destroyedAt: "2026-10-05T00:00:00Z" }),
  env("acme/demo", 6, "2026-11-01T00:00:00Z"),
];
const isDemo = (e: Environment) => e.repository === "acme/demo";
const common = { usage, environments, costPerHour: 1, now: NOW, isDemo };

// By repository, this month.
const byRepo = buildCostReport({ ...common, period: "month", by: "repo" });
assert.equal(byRepo.from, "2026-11-01");
assert.equal(byRepo.to, "2026-11-26");
const web = byRepo.rows.find((row) => row.name === "acme/web")!;
assert.equal(web.awakeSeconds, 5 * HOUR);
assert.equal(web.spend, 5);
assert.equal(web.alwaysOn, 28);
assert.equal(web.saved, 23);
assert.equal(web.previews, 2);
assert.equal(byRepo.rows[0].name, "acme/web", "the biggest spender is first");
// The day with no split lands in its own row, so nothing is lost and nothing is invented.
const rest = byRepo.rows.find((row) => row.name === UNATTRIBUTED)!;
assert.equal(rest.awakeSeconds, 2 * HOUR);
assert.equal(byRepo.totals.awakeSeconds, 11 * HOUR);
assert.equal(byRepo.totals.spend, 11);
// The demo and previews that ended before the period don't count; the total counts each preview once.
assert.ok(!byRepo.rows.some((row) => row.name === "acme/demo" || row.name === "acme/old"));
assert.equal(byRepo.totals.previews, 4);

// This week is the last seven days: the 18th is out.
const week = buildCostReport({ ...common, period: "week", by: "repo" });
assert.equal(week.from, "2026-11-20");
assert.equal(week.totals.awakeSeconds, 9 * HOUR);
assert.ok(!week.rows.some((row) => row.name === UNATTRIBUTED));

// By team: rules, owner by default.
const rules = parseTeams("web=acme/web,acme/site; platform = acme/* ;broken;=nothing;x=notarepo");
assert.deepEqual(rules.map((rule) => rule.team), ["web", "platform"]);
assert.equal(teamFor("ACME/web", rules), "web", "the first matching team wins");
assert.equal(teamFor("acme/api", rules), "platform");
assert.equal(teamFor("other/site", rules), "other", "no rule: the owner");
const byTeam = buildCostReport({ ...common, period: "month", by: "team", teams: rules });
assert.equal(byTeam.rows.find((row) => row.name === "web")!.awakeSeconds, 5 * HOUR);
assert.equal(byTeam.rows.find((row) => row.name === "platform")!.awakeSeconds, 2 * HOUR);
assert.equal(byTeam.rows.find((row) => row.name === "other")!.awakeSeconds, 2 * HOUR);
assert.equal(byTeam.totals.spend, byRepo.totals.spend);

// No usage at all: an empty report, not an error.
const empty = buildCostReport({ usage: undefined, environments: [], costPerHour: 1, period: "week", by: "repo", now: NOW });
assert.deepEqual(empty.rows, []);
assert.equal(empty.totals.spend, 0);

// CSV: a header, a row per repository, a total, and no formulas a spreadsheet would run.
const csv = reportToCsv(byRepo, "$");
const lines = csv.trim().split("\r\n");
assert.equal(lines[0], '"Mayfly cost report, 2026-11-01 to 2026-11-26 (UTC)"');
assert.equal(lines[1], "Repository,Awake hours,Asleep hours,Spend ($),Always-on cost ($),Saved ($),Previews");
assert.ok(lines.includes("acme/web,5,23,5.00,28.00,23.00,2"));
assert.ok(lines.at(-1)!.startsWith("Total,11,"));
assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
assert.equal(csvCell("+1"), "'+1");
assert.equal(csvCell('a "quoted", name'), '"a ""quoted"", name"');
assert.equal(csvCell(-3), "-3");
assert.match(reportToCsv(byTeam, "$"), /\r\nTeam,/);

// ISO weeks, and when the summary is due.
assert.equal(isoWeek(Date.parse("2026-11-26T12:00:00Z")).key, "2026-W48");
assert.equal(isoWeek(Date.parse("2026-01-01T00:00:00Z")).key, "2026-W01");
assert.equal(isoWeek(Date.parse("2027-01-01T00:00:00Z")).key, "2026-W53");
assert.equal(isoWeek(Date.parse("2024-12-30T00:00:00Z")).key, "2025-W01");
const monday9 = { weekday: 1, hour: 9 };
assert.equal(weeklyDue(undefined, Date.parse("2026-11-23T08:59:00Z"), monday9).due, false, "before Monday 09:00");
assert.equal(weeklyDue(undefined, Date.parse("2026-11-23T09:00:00Z"), monday9).due, true);
assert.equal(weeklyDue(undefined, Date.parse("2026-11-26T12:00:00Z"), monday9).due, true, "a server that was off still sends it");
assert.equal(weeklyDue({ lastWeekly: "2026-W48" }, Date.parse("2026-11-26T12:00:00Z"), monday9).due, false, "once a week");
assert.equal(weeklyDue({ lastWeekly: "2026-W47" }, Date.parse("2026-11-26T12:00:00Z"), monday9).due, true);
assert.equal(weeklyDue(undefined, Date.parse("2026-11-26T12:00:00Z"), { weekday: 5, hour: 9 }).due, false, "Friday hasn't come yet");
assert.deepEqual(reportScheduleFromEnv({}), { weekday: 1, hour: 9 });
assert.deepEqual(reportScheduleFromEnv({ REPORT_WEEKDAY: "5", REPORT_HOUR_UTC: "0" }), { weekday: 5, hour: 0 });
assert.deepEqual(reportScheduleFromEnv({ REPORT_WEEKDAY: "9", REPORT_HOUR_UTC: "30" }), { weekday: 1, hour: 9 });
assert.deepEqual(asReportState({ lastWeekly: "2026-W48" }), { lastWeekly: "2026-W48" });
assert.equal(asReportState({ lastWeekly: "yesterday" }), undefined);
assert.deepEqual(recipientsFromEnv({ REPORT_EMAIL_TO: "a@x.com, b@y.org ,not-an-email, <evil>@x.com" }), ["a@x.com", "b@y.org"]);

// The email.
const summary = buildWeeklySummary({
  week,
  teams: buildCostReport({ ...common, period: "week", by: "team", teams: rules }),
  budget: budgetStatus({ ...defaultBudget(), monthlyLimit: 20, pauseAtLimit: true }, 11, "2026-11"),
  currency: "$",
  boardUrl: "https://mayfly.example.com/admin",
});
assert.match(summary.subject, /^Mayfly weekly summary: .* saved, .* less than always-on$/);
assert.match(summary.text, /Previews slept for/);
assert.match(summary.text, /acme\/web/);
assert.match(summary.text, /55%/);
assert.match(summary.text, /https:\/\/mayfly\.example\.com\/admin/);
assert.match(summary.html, /<table/);
// Names from the data are escaped in the HTML.
const nasty = buildWeeklySummary({
  week: { ...week, rows: [{ ...week.rows[0], name: '<script>alert("x")</script>' }] },
  teams: week,
  budget: null,
  currency: "$",
  boardUrl: "https://x.test/?a=1&b=2",
});
assert.ok(!nasty.html.includes("<script>"));
assert.ok(nasty.html.includes("&lt;script&gt;"));
assert.ok(nasty.html.includes("a=1&amp;b=2"));

console.log("cost-report: ok");
