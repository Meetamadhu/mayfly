/**
 * The monthly budget: warn at 80 %, optionally pause at 100 %, one alert per threshold, and the pause shows up in
 * previewsPaused(). Run with: npx tsx scripts/test-budget.ts
 */
import assert from "node:assert/strict";
import {
  asBudget,
  budgetAlertFor,
  budgetAlertText,
  budgetStatus,
  defaultBudget,
  monthSpend,
  parseBudgetInput,
  previewsPaused,
  setCurrentBudgetStatus,
} from "../src/lib/budget";

const MONTH = "2026-11";
const base = { ...defaultBudget(), monthlyLimit: 100 };

// No limit: nothing to say, nothing paused.
assert.equal(budgetStatus(defaultBudget(), 500, MONTH).level, "off");
assert.equal(budgetStatus(defaultBudget(), 500, MONTH).paused, false);

// The levels.
assert.equal(budgetStatus(base, 79.9, MONTH).level, "ok");
assert.equal(budgetStatus(base, 80, MONTH).level, "warn");
assert.equal(budgetStatus(base, 99.99, MONTH).percent, 99);
assert.equal(budgetStatus(base, 100, MONTH).level, "over");

// Pausing only happens when asked for, and an admin can resume for the month.
assert.equal(budgetStatus(base, 120, MONTH).paused, false);
const pausing = { ...base, pauseAtLimit: true };
assert.equal(budgetStatus(pausing, 99, MONTH).paused, false);
assert.equal(budgetStatus(pausing, 100, MONTH).paused, true);
const resumed = budgetStatus({ ...pausing, resumedMonth: MONTH }, 150, MONTH);
assert.equal(resumed.paused, false);
assert.equal(resumed.resumed, true);
// A resume from last month doesn't carry over.
assert.equal(budgetStatus({ ...pausing, resumedMonth: "2026-10" }, 150, MONTH).paused, true);

// One alert per threshold per month.
let settings = { ...pausing };
let result = budgetAlertFor(settings, budgetStatus(settings, 50, MONTH));
assert.equal(result.alert, null);
result = budgetAlertFor(settings, budgetStatus(settings, 85, MONTH));
assert.equal(result.alert, "warn");
settings = { ...settings, notified: result.notified };
assert.equal(budgetAlertFor(settings, budgetStatus(settings, 90, MONTH)).alert, null, "the warning is sent once");
result = budgetAlertFor(settings, budgetStatus(settings, 101, MONTH));
assert.equal(result.alert, "over");
settings = { ...settings, notified: result.notified };
assert.equal(budgetAlertFor(settings, budgetStatus(settings, 130, MONTH)).alert, null, "reaching the limit is sent once");
// Jumping straight past 100 sends the "over" alert, not a warning too.
assert.equal(budgetAlertFor({ ...pausing }, budgetStatus(pausing, 140, MONTH)).alert, "over");
// A new month starts again.
assert.equal(budgetAlertFor(settings, budgetStatus(settings, 85, "2026-12")).alert, "warn");
// Raising the limit re-arms the alerts for when it's crossed again.
const raised = { ...settings, monthlyLimit: 500 };
const afterRaise = budgetAlertFor(raised, budgetStatus(raised, 101, MONTH));
assert.equal(afterRaise.alert, null);
assert.equal(afterRaise.notified?.reached, false);

const text = budgetAlertText("over", budgetStatus(pausing, 120, MONTH), "$");
assert.match(text.title, /paused/);
assert.match(budgetAlertText("warn", budgetStatus(pausing, 85, MONTH), "$").title, /85%/);

// Spend is the awake money of this month only.
const usage = { month: MONTH, awakeSeconds: 7200, asleepSeconds: 0, lastSampleAt: "2026-11-02T00:00:00.000Z" };
assert.equal(monthSpend(usage, 0.5, MONTH), 1);
assert.equal(monthSpend(usage, 0.5, "2026-12"), 0);
assert.equal(monthSpend(undefined, 0.5, MONTH), 0);

// What the page sends.
const parsed = parseBudgetInput({ monthlyLimit: "250.456", pauseAtLimit: true }, defaultBudget(), "2026-11-01T00:00:00.000Z");
assert.ok(parsed.ok && parsed.settings.monthlyLimit === 250.46 && parsed.settings.pauseAtLimit);
assert.ok(!parseBudgetInput({ monthlyLimit: -5 }, defaultBudget()).ok);
assert.ok(!parseBudgetInput({ monthlyLimit: "lots" }, defaultBudget()).ok);
assert.ok(!parseBudgetInput({ pauseAtLimit: "yes" }, defaultBudget()).ok);
assert.ok(!parseBudgetInput("nope", defaultBudget()).ok);
const cleared = parseBudgetInput({ monthlyLimit: null }, base);
assert.ok(cleared.ok && cleared.settings.monthlyLimit === null);
// Changing the limit ends an earlier "resume"; saving the same values doesn't.
const withResume = { ...pausing, resumedMonth: MONTH };
const changed = parseBudgetInput({ monthlyLimit: 200 }, withResume);
assert.ok(changed.ok && changed.settings.resumedMonth === null);
const same = parseBudgetInput({ monthlyLimit: 100, pauseAtLimit: true }, withResume);
assert.ok(same.ok && same.settings.resumedMonth === MONTH);

// Stored settings: damaged parts are dropped.
assert.equal(asBudget("junk"), undefined);
assert.equal(asBudget({ monthlyLimit: -1, pauseAtLimit: "x" })?.monthlyLimit, null);
assert.equal(asBudget({ monthlyLimit: 50, pauseAtLimit: true, notified: { month: "bad" } })?.notified, null);

// The shared flag the proxy and the lifecycle read.
setCurrentBudgetStatus(null);
assert.equal(previewsPaused(), false);
setCurrentBudgetStatus(budgetStatus(pausing, 100, MONTH));
assert.equal(previewsPaused(), true);
setCurrentBudgetStatus(budgetStatus(pausing, 10, MONTH));
assert.equal(previewsPaused(), false);
setCurrentBudgetStatus(null);

console.log("budget: ok");
