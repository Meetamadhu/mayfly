"use client";

import { hourlyRate } from "@/lib/sizes";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { cardState, estimatedCost, formatEstMoney, statePillLabel } from "@/components/board-parts";
import { BarChart, ChartLegend, type ChartSeries } from "@/components/charts";
import { CostControl } from "@/components/cost-control";
import { StateGlyph, repoAvatar } from "@/components/previews-view";
import {
  COST_PERIODS,
  estimateMonthly,
  formatHours,
  formatMoneyShort,
  periodSeconds,
  periodStart,
  previewsInPeriod,
  removalsInPeriod,
  spendBars,
  type CostPeriod,
} from "@/lib/cost-view";
import { FLEET_WINDOW_DAYS, REMOVAL_LABELS, REMOVAL_ORDER, fleetStats, formatLifespan } from "@/lib/fleet";
import { PreviewDetails } from "@/components/preview-details";
import { usualBuildMs } from "@/lib/preview-details";
import type { Environment } from "@/lib/types";
import { usePreviewActions, usePreviewPanel } from "@/lib/use-preview-actions";
import { useOverview } from "@/lib/use-overview";

const PERIOD_KEY = "mayfly-cost-period";
const TOP_SAVINGS = 5;

const SPEND_SERIES: ChartSeries[] = [
  { key: "always", label: "Always on", tone: "always" },
  { key: "mayfly", label: "With Mayfly", tone: "mayfly" },
];

function matchesSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!q) return true;
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber) === q ||
    (env.title ?? "").toLowerCase().includes(q) ||
    (env.author ?? "").toLowerCase().includes(q)
  );
}

export function CostPage() {
  const { overview, loadError, now, reload } = useOverview();
  const { signedIn, busy, error, run } = usePreviewActions(reload);
  const panel = usePreviewPanel();
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<CostPeriod>("month");
  const [showAll, setShowAll] = useState(false);
  const [perWeek, setPerWeek] = useState(12);
  const [hoursAwake, setHoursAwake] = useState(3);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PERIOD_KEY);
      if (saved === "week" || saved === "month") setPeriod(saved);
    } catch {
      // Storage can be blocked; the month is shown.
    }
  }, []);

  function choosePeriod(next: CostPeriod) {
    setPeriod(next);
    try {
      localStorage.setItem(PERIOD_KEY, next);
    } catch {
      // Not remembered, still applied.
    }
  }

  const config = overview?.config;
  const currency = overview?.currency ?? config?.currency ?? "$";
  const costPerHour = overview?.costPerHour ?? 0.05;
  const demoKey = config?.demo ?? null;
  const isDemo = (env: Environment) => `${env.repository}#${env.prNumber}` === demoKey;
  const envs = (overview?.environments ?? []).filter((env) => !isDemo(env));

  const start = periodStart(period, now);
  const seconds = periodSeconds(overview?.usage, period, now);
  const saved = estimatedCost(seconds.asleepMoney, costPerHour);
  const total = seconds.awake + seconds.asleep;
  const savedShare = total > 0 ? Math.round((seconds.asleep / total) * 100) : 0;
  const previews = previewsInPeriod(envs, start, now);
  const removals = removalsInPeriod(envs, start);
  const periodWords = period === "week" ? "last 7 days" : "this month";
  const bars = spendBars(overview?.usage, period, costPerHour, now);

  const fleet = overview ? fleetStats(overview.environments, { now, costPerHour, isDemo }) : null;
  const lifespanDays = fleet?.averageLifespanMs ? Math.max(0.25, fleet.averageLifespanMs / 86_400_000) : 2;
  const estimate = estimateMonthly({ perWeek, hoursAwake, lifespanDays, costPerHour });
  const removalRows = fleet
    ? REMOVAL_ORDER.filter((reason) => (fleet.reasons[reason] ?? 0) > 0).map((reason) => ({ reason, count: fleet.reasons[reason] ?? 0 }))
    : [];

  const savings = envs
    .filter((env) => matchesSearch(env, query))
    .map((env) => ({ env, saved: env.usage ? estimatedCost(env.usage.asleepSeconds, hourlyRate(env, costPerHour)) : -1 }))
    .sort((a, b) => b.saved - a.saved);
  const visible = showAll ? savings : savings.slice(0, TOP_SAVINGS);
  const biggest = Math.max(0.0001, ...savings.map((row) => row.saved));
  const owners = [...new Set(envs.map((env) => env.repository.split("/")[0]))];
  const panelEnv = panel.openId ? (overview?.environments.find((env) => env.id === panel.openId) ?? null) : null;

  return (
    <AppShell
      active="cost"
      githubConnected={Boolean(config?.githubConnected)}
      crumb={owners.length === 1 ? owners[0] : undefined}
      previewCount={overview ? (overview.environments.filter((env) => env.status !== "destroyed").length) : undefined}
      search={{ value: query, onChange: setQuery, placeholder: "Search repo, branch or person" }}
    >
      <header className="pv-head">
        <div className="pv-head-text">
          <h1 className="title-in-header">Cost</h1>
          <p className="pv-lede">
            Estimated from the hours each preview spent asleep. An awake preview counts as{" "}
            {formatEstMoney(costPerHour, currency)} an hour; a sleeping one costs nothing.
          </p>
        </div>
        <div className="pv-seg cost-period" role="group" aria-label="Period">
          {COST_PERIODS.map((item) => (
            <button key={item.id} type="button" aria-pressed={period === item.id} onClick={() => choosePeriod(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {loadError ? <p className="error" role="alert">{loadError}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}

      {signedIn ? <CostControl period={period} currency={currency} /> : null}

      <section className="cost-cards" aria-label="Totals">
        <div className="cost-hero">
          <p className="cost-hero-label">Saved {periodWords}</p>
          <strong className="cost-hero-value">{overview ? formatMoneyShort(saved, currency) : "…"}</strong>
          {savedShare > 0 ? <span className="cost-hero-pill">↓ {savedShare}% vs always on</span> : null}
        </div>
        <div className="cost-card" data-tone="awake">
          <span className="act-icon" data-tone="awake" aria-hidden="true">
            <StateGlyph tone="awake" />
          </span>
          <strong>{overview ? formatHours(seconds.awake) : "…"}</strong>
          <span className="cost-card-label">Awake hours</span>
          <span className="cost-card-sub">
            across {previews} preview{previews === 1 ? "" : "s"}
          </span>
        </div>
        <div className="cost-card" data-tone="asleep">
          <span className="act-icon" data-tone="asleep" aria-hidden="true">
            <StateGlyph tone="asleep" />
          </span>
          <strong>{overview ? formatHours(seconds.asleep) : "…"}</strong>
          <span className="cost-card-label">Asleep hours</span>
          <span className="cost-card-sub">no cost while asleep</span>
        </div>
        <div className="cost-card" data-tone="removed">
          <span className="act-icon" data-tone="failed" aria-hidden="true">
            <StateGlyph tone="failed" />
          </span>
          <strong>{overview ? removals.merged : "…"}</strong>
          <span className="cost-card-label">Removed after merge</span>
          <span className="cost-card-sub">
            {periodWords}
            {removals.total > removals.merged ? ` · ${removals.total} removed in all` : ""}
          </span>
        </div>
      </section>

      <div className="cost-middle">
        <section className="act-card" aria-labelledby="cost-spend-title">
          <div className="act-card-head">
            <div>
              <h2 id="cost-spend-title">{period === "week" ? "Spend by day" : "Spend by week"}</h2>
              <p>Always on vs with Mayfly</p>
            </div>
            <ChartLegend series={SPEND_SERIES} />
          </div>
          <BarChart
            caption={`Estimated spend ${periodWords}: always on vs with Mayfly`}
            series={SPEND_SERIES}
            columns={bars.map((bar) => ({ label: bar.label, title: bar.title, values: { always: bar.always, mayfly: bar.mayfly } }))}
            format={(value) => formatEstMoney(value, currency)}
            minTop={1}
            axisFormat={(value) => `${currency}${value > 0 && value < 10 && !Number.isInteger(value) ? value.toFixed(2) : Math.round(value)}`}
          />
        </section>

        <section className="act-card cost-estimate" aria-labelledby="cost-estimate-title">
          <div>
            <h2 id="cost-estimate-title">Estimate your own</h2>
            <p className="cost-muted">Move the sliders to match your team.</p>
          </div>
          <label className="cost-slider">
            <span>
              Previews opened per week <strong>{perWeek}</strong>
            </span>
            <input type="range" min={1} max={60} value={perWeek} onChange={(event) => setPerWeek(Number(event.target.value))} />
          </label>
          <label className="cost-slider">
            <span>
              Hours awake per day <strong>{hoursAwake}</strong>
            </span>
            <input type="range" min={1} max={24} value={hoursAwake} onChange={(event) => setHoursAwake(Number(event.target.value))} />
          </label>
          <div className="cost-compare" aria-live="polite">
            <div>
              <span>Always on</span>
              <strong>{formatMoneyShort(estimate.always, currency)}</strong>
            </div>
            <div data-tone="mayfly">
              <span>With Mayfly</span>
              <strong>{formatMoneyShort(estimate.mayfly, currency)}</strong>
            </div>
          </div>
          <p className="cost-muted cost-small">
            A month, with each preview open about {formatLifespan(lifespanDays * 86_400_000)}
            {fleet?.averageLifespanMs ? " (your average)" : ""}.
          </p>
        </section>
      </div>

      <section className="act-card cost-savings" aria-labelledby="cost-savings-title">
        <div className="act-card-head">
          <h2 id="cost-savings-title" className="act-card-title">
            Biggest savings
          </h2>
          <span className="cost-muted cost-small">Since each preview opened</span>
        </div>
        {overview && savings.length === 0 ? (
          <p className="act-empty">{query ? "No previews match the search." : "No previews yet."}</p>
        ) : null}
        <ol className="cost-list">
          {visible.map(({ env, saved: amount }) => {
            const avatar = repoAvatar(env.repository);
            const state = env.status === "destroyed" ? null : cardState(env);
            return (
              <li key={env.id}>
                <span className="pv-avatar" data-tone={avatar.tone} aria-hidden="true">
                  {avatar.letter}
                </span>
                <button type="button" className="cost-list-name" onClick={() => panel.open(env.id)}>
                  {env.title ?? env.branch}
                </button>
                <span className="cost-list-num">#{env.prNumber}</span>
                <span className="cost-list-state">
                  {state ? (
                    <span className="state-pill" data-state={state}>
                      {statePillLabel(state)}
                    </span>
                  ) : (
                    <span className="cost-muted">Removed</span>
                  )}
                </span>
                <span className="cost-list-hours">
                  {env.usage ? `${formatHours(env.usage.awakeSeconds)} awake · ${formatHours(env.usage.asleepSeconds)} asleep` : "Not tracked"}
                </span>
                <span className="cost-list-bar" aria-hidden="true">
                  <span style={{ width: `${amount > 0 ? Math.max(2, (amount / biggest) * 100) : 0}%` }} />
                </span>
                <strong className="cost-list-amount">{env.usage ? formatEstMoney(amount, currency) : "—"}</strong>
              </li>
            );
          })}
        </ol>
        {savings.length > TOP_SAVINGS ? (
          <button type="button" className="pv-link cost-more" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show the top 5" : `Show all ${savings.length}`}
          </button>
        ) : null}
      </section>

      <section className="act-card fleet-card fleet-panel" aria-labelledby="fleet-title">
        <div className="act-card-head">
          <h2 className="act-card-title" id="fleet-title">
            All previews
          </h2>
          <span className="cost-muted cost-small">Last {FLEET_WINDOW_DAYS} days · the demo isn&apos;t counted</span>
        </div>
        {fleet ? (
          <>
            <dl className="fleet-grid">
              <div>
                <dt>Cost per hour right now</dt>
                <dd>
                  {formatEstMoney(fleet.burnPerHour, currency)}
                  <span className="fleet-unit">an hour (est.)</span>
                </dd>
                <p className="fleet-sub">
                  {fleet.awakeNow} awake, {fleet.asleepNow} asleep. Sleeping previews cost nothing.
                </p>
              </div>
              <div>
                <dt>How long previews last</dt>
                <dd>{fleet.averageLifespanMs === null ? "–" : formatLifespan(fleet.averageLifespanMs)}</dd>
                <p className="fleet-sub">
                  {fleet.lifespanCount === 0
                    ? "No preview has been removed yet."
                    : `On average. Half last under ${formatLifespan(fleet.medianLifespanMs ?? 0)}.`}
                </p>
              </div>
              <div>
                <dt>Previews opened</dt>
                <dd>{fleet.created}</dd>
                <p className="fleet-sub">
                  {fleet.peak > 0 && fleet.peakAt
                    ? `Busiest: ${fleet.peak} at once, on ${new Date(fleet.peakAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                    : "None in the last 30 days."}
                </p>
              </div>
              <div>
                <dt>Cleaned up on their own</dt>
                <dd>{fleet.automaticShare === null ? "–" : `${Math.round(fleet.automaticShare * 100)}%`}</dd>
                <p className="fleet-sub">
                  {fleet.removed === 0
                    ? "Nothing removed in the last 30 days."
                    : `${fleet.removed - (fleet.reasons.manual ?? 0)} of ${fleet.removed} removed without anyone lifting a finger`}
                </p>
              </div>
            </dl>
            {removalRows.length > 0 ? (
              <div className="fleet-reasons">
                <p className="fleet-reasons-title">Why previews were removed</p>
                <div className="fleet-bar" aria-hidden="true">
                  {removalRows.map((row) => (
                    <span key={row.reason} data-reason={row.reason} style={{ flexGrow: row.count }} title={`${REMOVAL_LABELS[row.reason]}: ${row.count}`} />
                  ))}
                </div>
                <ul className="fleet-legend">
                  {removalRows.map((row) => (
                    <li key={row.reason}>
                      <span className="fleet-swatch" data-reason={row.reason} aria-hidden="true" />
                      {REMOVAL_LABELS[row.reason]} <strong>{row.count}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="act-empty">Loading…</p>
        )}
      </section>

      <p className="cost-foot">
        Assumes {formatEstMoney(costPerHour, currency)} an hour per running preview. These are estimates to compare
        with, not a bill.
      </p>

      <PreviewDetails
        env={panelEnv}
        demo={panelEnv ? isDemo(panelEnv) : false}
        now={now}
        signedIn={signedIn}
        busy={busy}
        error={error}
        currency={overview?.currency ?? overview?.config.currency ?? "$"}
        costPerHour={overview?.costPerHour ?? 0.05}
        fallbackSleepSeconds={overview?.config.sleepSeconds ?? 1800}
        usualBuildMs={usualBuildMs(overview?.environments ?? [])}
        backLabel="Cost"
        onAction={run}
        onClose={panel.close}
      />
    </AppShell>
  );
}
