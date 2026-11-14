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
  const lifecycleEnv = lifecycleId ? (overview?.environments.find((env) => env.id === lifecycleId) ?? null) : null;

  return (
    <AppShell
      active="cost"
      githubConnected={Boolean(config?.githubConnected)}
      search={{ value: query, onChange: setQuery, placeholder: "Filter previews by PR number, repo or branch" }}
    >
      <section className="board-welcome">
        <div>
          <h1>Cost &amp; savings</h1>
          <p className="lede">
            Estimated from how long previews were awake versus asleep, at {formatEstMoney(costPerHour, currency)} per
            preview-hour. These are estimates, not a bill.
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
          ? `${monthLabel}: awake ${formatSpan(awake)}, asleep ${formatSpan(asleep)} across all previews (demo not counted).`
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

      <section className="live-column page-panel" aria-label="Savings per preview">
        <div className="ledger-head">
          <div>
            <h2>Per preview</h2>
            <p className="help">Time each preview spent awake and asleep, and what sleeping saved. Highest first.</p>
          </div>
        </div>
        {overview && rows.length === 0 ? (
          <p className="empty">{query ? "No previews match this filter." : "No previews yet."}</p>
        ) : null}
        {rows.length > 0 ? (
          <div className="cost-table-wrap">
            <table className="cost-table">
              <thead>
                <tr>
                  <th scope="col">Preview</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Awake
                  </th>
                  <th scope="col" className="num">
                    Asleep
                  </th>
                  <th scope="col" className="num">
                    Est. saved
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
                      <td>
                        {state ? (
                          <span className="state-pill" data-state={state}>
                            {statePillLabel(state)}
                          </span>
                        ) : (
                          <span className="cost-table-removed">Removed</span>
                        )}
                      </td>
                      <td className="num">{usage ? formatSpan(usage.awakeSeconds) : "—"}</td>
                      <td className="num">{usage ? formatSpan(usage.asleepSeconds) : "—"}</td>
                      <td className="num">{usage ? formatEstMoney(saved, currency) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="help activity-note">
          “—” means the preview was removed before Mayfly started recording time per preview.
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
