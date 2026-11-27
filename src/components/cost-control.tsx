"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatHours, formatMoneyShort, type CostPeriod } from "@/lib/cost-view";
import type { CostReport, ReportBy } from "@/lib/cost-report";
import type { BudgetStatus } from "@/lib/budget";
import type { ScheduleWindow } from "@/lib/schedule";

/**
 * The Cost page's controls for admins: a monthly budget (warn at 80 %, optionally pause at 100 %), a report by
 * repository or team with a CSV download and a weekly email, and awake hours for demos and reviews.
 */

type BudgetView = {
  status: BudgetStatus;
  settings: { monthlyLimit: number | null; pauseAtLimit: boolean };
  currency: string;
  email: { configured: boolean; problem: string | null; recipients: number; when: string };
  lastWeekly: string | null;
  thisWeek: string;
};

type WindowDraft = {
  key: string;
  id?: string;
  repository: string;
  days: number[];
  start: string;
  end: string;
  timezone: string;
};

const DAY_LABELS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function newWindow(): WindowDraft {
  return {
    key: `w-${Math.random().toString(36).slice(2, 10)}`,
    repository: "*",
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function fromServer(windows: (ScheduleWindow & { label?: string })[]): WindowDraft[] {
  return windows.map((window) => ({
    key: window.id,
    id: window.id,
    repository: window.repository,
    days: [...window.days],
    start: window.start,
    end: window.end,
    timezone: window.timezone,
  }));
}

async function readJson<T>(response: Response): Promise<T & { error?: string; ok?: boolean }> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!response.ok) throw new Error(body.error || `Something went wrong (error ${response.status}).`);
  return body;
}

export function CostControl({ period, currency }: { period: CostPeriod; currency: string }) {
  return (
    <div className="cost-control">
      <BudgetPanel />
      <ReportPanel period={period} currency={currency} />
      <SchedulePanel />
    </div>
  );
}

function BudgetPanel() {
  const [view, setView] = useState<BudgetView | null>(null);
  const [limit, setLimit] = useState("");
  const [pause, setPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const body = await readJson<BudgetView>(await fetch("/api/budget", { credentials: "include", cache: "no-store" }));
    setView(body);
    setLimit(body.settings.monthlyLimit == null ? "" : String(body.settings.monthlyLimit));
    setPause(body.settings.pauseAtLimit);
  }, []);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : "Couldn't load the budget."));
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await readJson<BudgetView>(
        await fetch("/api/budget", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ monthlyLimit: limit.trim() === "" ? null : limit.trim(), pauseAtLimit: pause }),
        }),
      );
      setView(body);
      setLimit(body.settings.monthlyLimit == null ? "" : String(body.settings.monthlyLimit));
      setPause(body.settings.pauseAtLimit);
      setNotice(body.settings.monthlyLimit == null ? "No monthly limit." : "Budget saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save the budget.");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const body = await readJson<BudgetView>(await fetch("/api/budget/resume", { method: "POST", credentials: "include" }));
      setView(body);
      setNotice("Previews will keep running for the rest of this month.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't resume previews.");
    } finally {
      setBusy(false);
    }
  }

  const status = view?.status;
  const tone = status?.level === "over" ? "bad" : status?.level === "warn" ? "warn" : status?.level === "ok" ? "ok" : undefined;

  return (
    <section className="act-card cost-ctrl" aria-labelledby="cost-budget-title">
      <div className="act-card-head">
        <div>
          <h2 id="cost-budget-title">Monthly budget</h2>
          <p>Mayfly warns at 80% of the limit{status?.pauseAtLimit ? ", and pauses previews at 100%" : ""}.</p>
        </div>
        {status && status.level !== "off" ? (
          <span className="adm-chip" data-tone={tone}>
            {status.paused ? "Paused" : status.resumed ? "Over, resumed" : status.level === "over" ? "Over the limit" : status.level === "warn" ? `${status.percent}% used` : `${status.percent}% used`}
          </span>
        ) : null}
      </div>

      {status && status.limit !== null ? (
        <div className="cost-budget-meter" aria-label={`${status.percent}% of the monthly budget used`}>
          <div className="cost-budget-bar" data-tone={tone}>
            <span style={{ width: `${Math.min(100, status.percent)}%` }} />
          </div>
          <p>
            {formatMoneyShort(status.spend, view?.currency ?? "$")} of {formatMoneyShort(status.limit, view?.currency ?? "$")} this month
            {status.paused ? " · sleeping previews stay asleep and new ones aren't started" : ""}
          </p>
        </div>
      ) : (
        <p className="cost-muted">No limit yet. Set one below if you want a warning before spend climbs.</p>
      )}

      <form className="cost-ctrl-form" onSubmit={(event) => void save(event)}>
        <label className="cost-ctrl-field">
          <span>Limit this month</span>
          <input
            inputMode="decimal"
            value={limit}
            placeholder="No limit"
            onChange={(event) => setLimit(event.target.value)}
            aria-describedby="cost-budget-hint"
          />
        </label>
        <label className="cost-ctrl-check">
          <input type="checkbox" checked={pause} onChange={(event) => setPause(event.target.checked)} />
          Pause previews when the limit is reached
        </label>
        <p className="cost-muted cost-small" id="cost-budget-hint">
          Leave blank for no limit. Alerts go to the same place as other Mayfly alerts (ALERT_WEBHOOK_URL).
        </p>
        <div className="cost-ctrl-actions">
          <button type="submit" className="pv-btn pv-btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save budget"}
          </button>
          {status?.paused || status?.resumed ? (
            <button type="button" className="pv-btn" disabled={busy || Boolean(status?.resumed)} onClick={() => void resume()}>
              {status?.resumed ? "Resumed for this month" : "Resume previews this month"}
            </button>
          ) : null}
        </div>
      </form>
      {notice ? <p className="cost-notice" role="status">{notice}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ReportPanel({ period, currency }: { period: CostPeriod; currency: string }) {
  const [by, setBy] = useState<ReportBy>("repo");
  const [report, setReport] = useState<CostReport | null>(null);
  const [hasTeams, setHasTeams] = useState(false);
  const [email, setEmail] = useState<BudgetView["email"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [reportBody, budgetBody] = await Promise.all([
      readJson<{ report: CostReport; teams: boolean }>(
        await fetch(`/api/cost-report?period=${period}&by=${by}`, { credentials: "include", cache: "no-store" }),
      ),
      readJson<BudgetView>(await fetch("/api/budget", { credentials: "include", cache: "no-store" })),
    ]);
    setReport(reportBody.report);
    setHasTeams(Boolean(reportBody.teams));
    setEmail(budgetBody.email);
  }, [period, by]);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : "Couldn't load the report."));
  }, [load]);

  async function sendEmail() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await readJson<{ to: number; subject: string }>(
        await fetch("/api/cost-report/email", { method: "POST", credentials: "include" }),
      );
      setNotice(`Sent “${body.subject}” to ${body.to} recipient${body.to === 1 ? "" : "s"}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't send the email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="act-card cost-ctrl" aria-labelledby="cost-report-title">
      <div className="act-card-head">
        <div>
          <h2 id="cost-report-title">Cost by {by === "team" ? "team" : "repository"}</h2>
          <p>
            {report ? `${report.from} to ${report.to} (UTC)` : "Loading…"}
            {hasTeams ? "" : ". Set PREVIEW_TEAMS to group repositories into teams."}
          </p>
        </div>
        <div className="pv-seg" role="group" aria-label="Group by">
          <button type="button" aria-pressed={by === "repo"} onClick={() => setBy("repo")}>
            Repository
          </button>
          <button type="button" aria-pressed={by === "team"} onClick={() => setBy("team")}>
            Team
          </button>
        </div>
      </div>

      {report && report.rows.length === 0 ? <p className="act-empty">Nothing to report for this period yet.</p> : null}
      {report && report.rows.length > 0 ? (
        <div className="cost-report-table-wrap">
          <table className="cost-report-table">
            <thead>
              <tr>
                <th scope="col">{by === "team" ? "Team" : "Repository"}</th>
                <th scope="col">Awake</th>
                <th scope="col">Asleep</th>
                <th scope="col">Spend</th>
                <th scope="col">Saved</th>
                <th scope="col">Previews</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>{formatHours(row.awakeSeconds)}</td>
                  <td>{formatHours(row.asleepSeconds)}</td>
                  <td>{formatMoneyShort(row.spend, currency)}</td>
                  <td>{formatMoneyShort(row.saved, currency)}</td>
                  <td>{row.previews}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{formatHours(report.totals.awakeSeconds)}</td>
                <td>{formatHours(report.totals.asleepSeconds)}</td>
                <td>{formatMoneyShort(report.totals.spend, currency)}</td>
                <td>{formatMoneyShort(report.totals.saved, currency)}</td>
                <td>{report.totals.previews}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      <div className="cost-ctrl-actions">
        <a className="pv-btn" href={`/api/cost-report?period=${period}&by=${by}&format=csv`}>
          Download CSV
        </a>
        <button type="button" className="pv-btn" disabled={busy || !email?.configured} onClick={() => void sendEmail()}>
          {busy ? "Sending…" : "Email this week's summary now"}
        </button>
      </div>
      {email ? (
        <p className="cost-muted cost-small">
          {email.configured
            ? `Weekly email goes to ${email.recipients} address${email.recipients === 1 ? "" : "es"} every ${email.when}.`
            : email.problem}
        </p>
      ) : null}
      {notice ? <p className="cost-notice" role="status">{notice}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function SchedulePanel() {
  const [windows, setWindows] = useState<WindowDraft[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const body = await readJson<{ windows: (ScheduleWindow & { label: string })[] }>(
      await fetch("/api/schedules", { credentials: "include", cache: "no-store" }),
    );
    setWindows(fromServer(body.windows));
    setLabels(Object.fromEntries(body.windows.map((window) => [window.id, window.label])));
  }, []);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : "Couldn't load the schedules."));
  }, [load]);

  function edit(key: string, patch: Partial<WindowDraft>) {
    setWindows((list) => list.map((window) => (window.key === key ? { ...window, ...patch } : window)));
  }

  function toggleDay(key: string, day: number) {
    setWindows((list) =>
      list.map((window) => {
        if (window.key !== key) return window;
        const days = window.days.includes(day) ? window.days.filter((item) => item !== day) : [...window.days, day].sort((a, b) => a - b);
        return { ...window, days };
      }),
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await readJson<{ windows: (ScheduleWindow & { label: string })[] }>(
        await fetch("/api/schedules", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            windows: windows.map(({ id, repository, days, start, end, timezone }) => ({
              ...(id ? { id } : {}),
              repository,
              days,
              start,
              end,
              timezone,
            })),
          }),
        }),
      );
      setWindows(fromServer(body.windows));
      setLabels(Object.fromEntries(body.windows.map((window) => [window.id, window.label])));
      setNotice(body.windows.length === 0 ? "No awake hours set." : "Awake hours saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save the schedules.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="act-card cost-ctrl" aria-labelledby="cost-schedule-title">
      <div className="act-card-head">
        <div>
          <h2 id="cost-schedule-title">Awake hours</h2>
          <p>Keep previews awake during demo hours. To warm one up for a review, open that preview and schedule a wake.</p>
        </div>
      </div>

      <form onSubmit={(event) => void save(event)}>
        {windows.length === 0 ? <p className="act-empty">No awake hours yet. Add a rule for the hours you want previews to stay warm.</p> : null}
        <ul className="cost-schedule-list">
          {windows.map((window) => (
            <li key={window.key} className="cost-schedule-row">
              <label className="cost-ctrl-field">
                <span>Repository</span>
                <input
                  className="mono"
                  value={window.repository}
                  placeholder="owner/name or *"
                  spellCheck={false}
                  onChange={(event) => edit(window.key, { repository: event.target.value })}
                />
              </label>
              <fieldset className="cost-schedule-days">
                <legend>Days</legend>
                {DAY_LABELS.map(({ day, label }) => (
                  <label key={day}>
                    <input type="checkbox" checked={window.days.includes(day)} onChange={() => toggleDay(window.key, day)} />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="cost-ctrl-field">
                <span>From</span>
                <input className="mono" value={window.start} onChange={(event) => edit(window.key, { start: event.target.value })} />
              </label>
              <label className="cost-ctrl-field">
                <span>To</span>
                <input className="mono" value={window.end} onChange={(event) => edit(window.key, { end: event.target.value })} />
              </label>
              <label className="cost-ctrl-field">
                <span>Time zone</span>
                <input value={window.timezone} spellCheck={false} onChange={(event) => edit(window.key, { timezone: event.target.value })} />
              </label>
              {window.id && labels[window.id] ? <p className="cost-muted cost-small">{labels[window.id]}</p> : null}
              <button
                type="button"
                className="pv-link"
                onClick={() => setWindows((list) => list.filter((item) => item.key !== window.key))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="cost-ctrl-actions">
          <button type="button" className="pv-btn" disabled={windows.length >= 30} onClick={() => setWindows((list) => [...list, newWindow()])}>
            + Add awake hours
          </button>
          <button type="submit" className="pv-btn pv-btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save awake hours"}
          </button>
        </div>
      </form>
      {notice ? <p className="cost-notice" role="status">{notice}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
