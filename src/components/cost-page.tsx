"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  CostUsageChart,
  LifecycleDrawer,
  cardState,
  estimatedCost,
  formatEstMoney,
  formatSaved,
  statePillLabel,
} from "@/components/board-parts";
import {
  FLEET_WINDOW_DAYS,
  REMOVAL_LABELS,
  REMOVAL_ORDER,
  fleetStats,
  formatLifespan,
} from "@/lib/fleet";
import type { Environment } from "@/lib/types";
import { useOverview } from "@/lib/use-overview";

/** "< 1 min", "24 min", "3.4 h", "2.1 d". */
function formatSpan(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  if (seconds < 60) return "< 1 min";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

function matchesSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return env.repository.toLowerCase().includes(q) || env.branch.toLowerCase().includes(q) || String(env.prNumber) === q;
}

export function CostPage() {
  const { overview, loadError } = useOverview();
  const [query, setQuery] = useState("");
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);

  const config = overview?.config;
  const currency = overview?.currency ?? config?.currency ?? "$";
  const costPerHour = overview?.costPerHour ?? 0.05;
  const demoKey = config?.demo ?? null;
  const isDemo = (env: Environment) => `${env.repository}#${env.prNumber}` === demoKey;
  const awake = overview?.usage?.awakeSeconds ?? 0;
  const asleep = overview?.usage?.asleepSeconds ?? 0;
  const total = awake + asleep;
  const alwaysAwake = estimatedCost(total, costPerHour);
  const withMayfly = estimatedCost(awake, costPerHour);
  const asleepShare = total > 0 ? Math.round((asleep / total) * 1000) / 10 : 0;
  const monthLabel = overview?.usage?.month
    ? new Date(`${overview.usage.month}-01T00:00:00Z`).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "this month";

  const rows = (overview?.environments ?? [])
    .filter((env) => !isDemo(env) && matchesSearch(env, query))
    .map((env) => {
      const usage = env.usage;
      return {
        env,
        usage,
        saved: usage ? estimatedCost(usage.asleepSeconds, costPerHour) : -1,
      };
    })
    .sort((a, b) => b.saved - a.saved);
  const fleet = overview
    ? fleetStats(overview.environments, { now: Date.now(), costPerHour, isDemo })
    : null;
  const removalRows = fleet
    ? REMOVAL_ORDER.filter((reason) => (fleet.reasons[reason] ?? 0) > 0).map((reason) => ({
        reason,
        count: fleet.reasons[reason] ?? 0,
      }))
    : [];
  const lifecycleEnv = lifecycleId ? (overview?.environments.find((env) => env.id === lifecycleId) ?? null) : null;

  return (
    <AppShell
      active="cost"
      githubConnected={Boolean(config?.githubConnected)}
      search={{ value: query, onChange: setQuery, placeholder: "Search PR, repo or branch" }}
    >
      <section className="board-welcome">
        <div>
          <h1>Cost &amp; savings</h1>
          <p className="lede">
            A preview that&apos;s awake is counted at {formatEstMoney(costPerHour, currency)} an hour; a sleeping one costs
            nothing. These are estimates to compare with, not a bill.
          </p>
        </div>
      </section>

      <dl className="stats board-stats page-stats">
        <div data-stat="savings">
          <dt>Estimated saved</dt>
          <dd>{overview ? formatSaved(overview.savedEstimate, currency) : "–"}</dd>
        </div>
        <div data-stat="live">
          <dt>If always awake</dt>
          <dd>{overview ? formatEstMoney(alwaysAwake, currency) : "–"}</dd>
        </div>
        <div data-stat="awake">
          <dt>With Mayfly</dt>
          <dd>{overview ? formatEstMoney(withMayfly, currency) : "–"}</dd>
        </div>
        <div data-stat="asleep">
          <dt>Time asleep</dt>
          <dd>{overview ? `${asleepShare}%` : "–"}</dd>
        </div>
      </dl>

      <p className="board-settings">
        {overview
          ? `In ${monthLabel}, previews were awake for ${formatSpan(awake)} and asleep for ${formatSpan(asleep)} in total (the demo isn’t counted).`
          : "Loading usage…"}
      </p>

      {loadError ? <p className="error" role="alert">{loadError}</p> : null}

      <section className="board-rail-card page-panel cost-chart-panel" aria-label="Estimated spend this month">
        <div className="board-rail-head">
          <h2 className="board-rail-title">Spend this month</h2>
          <span className="board-rail-note">Estimated · always awake vs with Mayfly</span>
        </div>
        {overview ? <CostUsageChart usage={overview.usage} costPerHour={costPerHour} currency={currency} /> : null}
      </section>

      <section className="board-rail-card page-panel fleet-panel" aria-labelledby="fleet-title">
        <div className="board-rail-head">
          <h2 className="board-rail-title" id="fleet-title">
            All previews
          </h2>
          <span className="board-rail-note">Last {FLEET_WINDOW_DAYS} days · the demo isn&apos;t counted</span>
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
                    : `On average. Half last under ${formatLifespan(fleet.medianLifespanMs ?? 0)}. Based on ${fleet.lifespanCount} removed preview${fleet.lifespanCount === 1 ? "" : "s"}.`}
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
                    <span
                      key={row.reason}
                      data-reason={row.reason}
                      style={{ flexGrow: row.count }}
                      title={`${REMOVAL_LABELS[row.reason]}: ${row.count}`}
                    />
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
          <p className="help">Loading…</p>
        )}
      </section>

      <section className="live-column page-panel" aria-label="Savings per preview">
        <div className="ledger-head">
          <div>
            <h2>Per preview</h2>
            <p className="help">How long each preview was awake and asleep, and how much sleeping saved. Biggest savings first.</p>
          </div>
        </div>
        {overview && rows.length === 0 ? (
          <p className="empty">{query ? "No previews match this filter." : "No previews yet."}</p>
        ) : null}
        {rows.length > 0 ? (
          <div className="cost-table-wrap">
            <table className="cost-table stack-on-phone">
              <thead>
                <tr>
                  <th scope="col">Preview</th>
                  <th scope="col">Now</th>
                  <th scope="col" className="num">
                    Awake
                  </th>
                  <th scope="col" className="num">
                    Asleep
                  </th>
                  <th scope="col" className="num">
                    Saved (est.)
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ env, usage, saved }) => {
                  const state = env.status === "destroyed" ? null : cardState(env);
                  return (
                    <tr key={env.id}>
                      <th scope="row">
                        <button type="button" className="activity-subject" onClick={() => setLifecycleId(env.id)}>
                          PR #{env.prNumber}
                        </button>
                        <span className="cost-table-sub mono">{env.branch}</span>
                      </th>
                      <td data-label="Now">
                        {state ? (
                          <span className="state-pill" data-state={state}>
                            {statePillLabel(state)}
                          </span>
                        ) : (
                          <span className="cost-table-removed">Removed</span>
                        )}
                      </td>
                      <td className="num" data-label="Awake">{usage ? formatSpan(usage.awakeSeconds) : "—"}</td>
                      <td className="num" data-label="Asleep">{usage ? formatSpan(usage.asleepSeconds) : "—"}</td>
                      <td className="num" data-label="Saved (est.)">{usage ? formatEstMoney(saved, currency) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="help activity-note">
          “—” means the preview was removed before Mayfly started keeping track of time.
        </p>
      </section>

      <LifecycleDrawer
        env={lifecycleEnv}
        demo={lifecycleEnv ? isDemo(lifecycleEnv) : false}
        onClose={() => setLifecycleId(null)}
      />
    </AppShell>
  );
}
