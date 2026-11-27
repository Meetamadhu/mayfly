import { currentBudgetStatus } from "./budget";
import { getConfig, previewCostPerHour, previewCurrency } from "./config";
import { buildCostReport, parseTeams } from "./cost-report";
import { applyScheduling } from "./lifecycle";
import { mailSettings, sendMail } from "./mailer";
import { exclusive, loadState, saveState } from "./store";
import { isLiveStatus, type Environment } from "./types";
import { buildWeeklySummary, isoWeek, recipientsFromEnv, reportScheduleFromEnv, weeklyDue } from "./weekly-report";

/**
 * The jobs that run on the reaper's tick besides tidying up: applying awake hours and pre-wakes, and sending the
 * weekly summary. Each one catches its own errors, so one failing never stops the others.
 */

function isDemoEnv(env: Environment) {
  const demo = getConfig().demo;
  return Boolean(demo && env.repository === demo.repository && env.prNumber === demo.prNumber);
}

export type SendResult = { ok: true; to: string[]; subject: string } | { ok: false; error: string };

/** Build and send the weekly summary now. `weekKey` is remembered, so the automatic send doesn't repeat it. */
export async function sendWeeklySummary(now = Date.now(), options: { remember?: boolean } = {}): Promise<SendResult> {
  const mail = mailSettings();
  if (!mail.ok) return { ok: false, error: mail.problem };
  const to = recipientsFromEnv();
  if (to.length === 0) return { ok: false, error: "Add REPORT_EMAIL_TO, the address (or a comma-separated list) that should get the summary." };

  const state = await exclusive(async () => loadState());
  const rules = parseTeams(process.env["PREVIEW_TEAMS"]);
  const common = { usage: state.usage, environments: state.environments, costPerHour: previewCostPerHour(), now, isDemo: isDemoEnv };
  const summary = buildWeeklySummary({
    week: buildCostReport({ ...common, period: "week", by: "repo", teams: rules }),
    teams: buildCostReport({ ...common, period: "week", by: "team", teams: rules }),
    budget: currentBudgetStatus(),
    currency: previewCurrency(),
    boardUrl: `${getConfig().previewBaseUrl}/admin`,
  });
  try {
    await sendMail(mail.settings.target, { from: mail.settings.from, to, ...summary });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The email couldn't be sent." };
  }
  if (options.remember) {
    const { key } = isoWeek(now);
    await exclusive(async () => {
      const fresh = await loadState();
      fresh.reports = { lastWeekly: key };
      await saveState(fresh);
    });
  }
  return { ok: true, to, subject: summary.subject };
}

/** Send the summary when it's due and email is set up. Without SMTP_URL nothing happens, quietly. */
async function maybeSendWeekly(now: number) {
  if (!(process.env["SMTP_URL"] ?? "").trim() || recipientsFromEnv().length === 0) return;
  const state = await exclusive(async () => loadState());
  // A server with nothing to report doesn't email about it.
  if (!state.usage && !state.environments.some((env) => isLiveStatus(env.status))) return;
  const { due } = weeklyDue(state.reports, now, reportScheduleFromEnv());
  if (!due) return;
  // After a failure, wait a while before trying again rather than on every tick.
  if (now - lastWeeklyAttempt < RETRY_MS) return;
  lastWeeklyAttempt = now;
  const sent = await sendWeeklySummary(now, { remember: true });
  if (sent.ok) console.log(`Weekly summary emailed to ${sent.to.length} recipient(s).`);
  else {
    // Try again on the next tick, but don't spam the log every few seconds.
    if (lastWeeklyError !== sent.error) console.error(`Weekly summary not sent: ${sent.error}`);
    lastWeeklyError = sent.error;
  }
}

let lastWeeklyError = "";
let lastWeeklyAttempt = 0;
const RETRY_MS = 15 * 60_000;

export async function runAutomation(now = Date.now()) {
  try {
    await applyScheduling(now);
  } catch (error) {
    console.error("Scheduled wake and sleep failed", error);
  }
  try {
    await maybeSendWeekly(now);
  } catch (error) {
    console.error("Weekly summary failed", error);
  }
}
