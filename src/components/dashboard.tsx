"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  EnvironmentCard,
  LifecycleDrawer,
  StateIcon,
  StatIcon,
  boardRecentActivity,
  estimatedCost,
  formatAgo,
  formatEstMoney,
  formatLifetime,
  formatSaved,
  formatSleep,
  matchesBoardFilter,
  matchesBoardSearch,
  previewPath,
  readStoredView,
  writeStoredView,
  type BoardFilter,
} from "@/components/board-parts";
import type { Environment } from "@/lib/types";
import { useOverview } from "@/lib/use-overview";

const DASHBOARD_PREVIEW_LIMIT = 2;

export function Dashboard() {
  const { overview, loadError, polledAt, now, reload } = useOverview();
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [boardQuery, setBoardQuery] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [cardView, setCardView] = useState<"grid" | "list">("grid");
  const [busy, setBusy] = useState(false);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);
  const [showAllCards, setShowAllCards] = useState(false);

  useEffect(() => {
    setCardView(readStoredView());
    // Searches started from another page arrive as /board?q=…
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setBoardQuery(q);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { signedIn?: boolean }) => {
        if (!cancelled) setSignedIn(Boolean(body.signedIn));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function chooseCardView(next: "grid" | "list") {
    setCardView(next);
    writeStoredView(next);
  }

  async function adminAction(env: Environment, action: "sleep" | "extend" | "destroy") {
    if (action === "destroy" && !window.confirm(`Destroy ${env.repository} #${env.prNumber}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        action === "destroy"
          ? `/api/environments/${env.id}?action=destroy&wait=1`
          : action === "sleep"
            ? `/api/environments/${env.id}?action=sleep`
            : `/api/environments/${env.id}?action=extend&hours=4`;
      const response = await fetch(path, { method: "POST", credentials: "include" });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `${action} failed.`);
      }
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const config = overview?.config;
  const currency = overview?.currency ?? config?.currency ?? "$";
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const demoKey = config?.demo ?? null;
  const visible = current.filter(
    (env) => matchesBoardFilter(env, boardFilter, now, demoKey) && matchesBoardSearch(env, boardQuery),
  );
  // The Dashboard shows two previews; the rest sit behind "Show all". Searching or filtering shows every match.
  const narrowing = boardFilter !== "all" || boardQuery.trim() !== "";
  const shown = showAllCards || narrowing ? visible : visible.slice(0, DASHBOARD_PREVIEW_LIMIT);
  const hiddenCount = visible.length - shown.length;
  // "Show all" gives the previews the whole width: the Cost & Usage and Recent activity cards step aside.
  const expanded = showAllCards && !narrowing && visible.length > DASHBOARD_PREVIEW_LIMIT;
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  const dockerRuntime = config?.allowedRepositories != null;
  const liveCount = overview?.summary.live ?? 0;
  const capacity = config?.maxConcurrent ?? 0;
  const capacityRatio = capacity > 0 ? Math.min(1, liveCount / capacity) : 0;
  const buildingCount = current.filter((env) => env.status === "provisioning" || env.status === "updating").length;
  const activity = overview ? boardRecentActivity(overview.environments, demoKey).slice(0, 6) : [];
  const lifecycleEnv = lifecycleId ? (overview?.environments.find((env) => env.id === lifecycleId) ?? null) : null;
  const costPerHour = overview?.costPerHour ?? 0.05;
  const alwaysAwakeEstimate = overview
    ? estimatedCost((overview.usage?.awakeSeconds ?? 0) + (overview.usage?.asleepSeconds ?? 0), costPerHour)
    : 0;
  const withMayflyEstimate = overview ? estimatedCost(overview.usage?.awakeSeconds ?? 0, costPerHour) : 0;

  return (
    <AppShell
      active="dashboard"
      githubConnected={Boolean(config?.githubConnected)}
      search={{ value: boardQuery, onChange: setBoardQuery, placeholder: "Search repo or branch" }}
    >
      {config?.deployer === "fake" ? (
        <p className="notice" role="status">
          Simulation mode: previews are recorded, not run.
          {process.env.NEXT_PUBLIC_LIVE_DEMO_URL ? (
            <>
              {" "}
              <a href={process.env.NEXT_PUBLIC_LIVE_DEMO_URL}>Open the live demo</a>
            </>
          ) : null}
        </p>
      ) : null}

      <section className="board-welcome">
        <div>
          <h1>Welcome to Mayfly</h1>
          <p className="lede">
            Ephemeral preview environments for every pull request — build, preview, sleep and destroy automatically.
          </p>
        </div>
        {signedIn ? (
          <a className="btn secondary" href="/admin#simulator">
            Simulate PR
          </a>
        ) : null}
      </section>

      <dl className="stats board-stats">
        <div data-stat="live">
          <dt className="stat-head">
            <span>Live</span>
            <span className="stat-icon" aria-hidden="true">
              <StatIcon name="live" />
            </span>
          </dt>
          <dd>
            {overview ? liveCount : "–"}
            <span>/{capacity || "–"}</span>
          </dd>
          <div className="meter" aria-hidden="true">
            <span data-hot={capacityRatio >= 0.8 ? "true" : "false"} style={{ width: `${capacityRatio * 100}%` }} />
          </div>
        </div>
        <div data-stat="awake">
          <dt className="stat-head">
            <span>Running</span>
            <span className="stat-icon" aria-hidden="true">
              <StatIcon name="running" />
            </span>
          </dt>
          <dd>{overview?.summary.awake ?? "–"}</dd>
        </div>
        <div data-stat="asleep">
          <dt className="stat-head">
            <span>Sleeping</span>
            <span className="stat-icon" aria-hidden="true">
              <StatIcon name="sleeping" />
            </span>
          </dt>
          <dd>{overview?.summary.asleep ?? "–"}</dd>
        </div>
        <div data-stat="building">
          <dt className="stat-head">
            <span>Building</span>
            <span className="stat-icon" aria-hidden="true">
              <StatIcon name="building" />
            </span>
          </dt>
          <dd>{overview ? buildingCount : "–"}</dd>
        </div>
        <div data-stat="savings">
          <dt className="stat-head">
            <span>Estimated</span>
            <span className="stat-icon" aria-hidden="true">
              <StatIcon name="savings" />
            </span>
          </dt>
          <dd>{overview ? formatSaved(overview.savedEstimate, currency) : "–"}</dd>
        </div>
      </dl>

      <p className="board-settings">
        {config
          ? `Sleeps after ${formatSleep(config.sleepSeconds)} · Max lifetime ${formatLifetime(config.ttlHours)}`
          : "Sleeps after – · Max lifetime –"}
      </p>

      <div className="board-workspace" data-expanded={expanded ? "true" : "false"}>
        <section className="live-column">
          <div className="ledger-head">
            <div>
              <h2>Active environments</h2>
              <p className="help">Live previews, running or asleep.</p>
            </div>
            <div className="board-view-toggle" role="group" aria-label="Card layout">
              <button type="button" aria-pressed={cardView === "grid"} onClick={() => chooseCardView("grid")}>
                Grid
              </button>
              <button type="button" aria-pressed={cardView === "list"} onClick={() => chooseCardView("list")}>
                List
              </button>
            </div>
          </div>

          <div className="board-filters">
            <div className="board-filter-pills" role="group" aria-label="Filter previews">
              {(
                [
                  ["all", "All"],
                  ["awake", "Awake"],
                  ["asleep", "Asleep"],
                  ["expiring", "Expiring soon"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="board-filter-pill"
                  aria-pressed={boardFilter === id}
                  onClick={() => setBoardFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="empty">Loading previews…</p> : null}

          <div className="stack env-card-stack" data-view={cardView}>
            {overview && current.length === 0 ? (
              <p className="empty">No live previews. Open a pull request and it will show up here.</p>
            ) : null}
            {overview && current.length > 0 && visible.length === 0 ? (
              <p className="empty">No previews match this filter.</p>
            ) : null}
            {shown.map((env) => (
              <EnvironmentCard
                key={env.id}
                env={env}
                now={now}
                demo={demoKey === `${env.repository}#${env.prNumber}`}
                signedIn={signedIn}
                busy={busy}
                onAdminAction={(item, action) => void adminAction(item, action)}
                onShowLifecycle={(item) => setLifecycleId(item.id)}
              />
            ))}
          </div>

          {hiddenCount > 0 || (showAllCards && !narrowing && visible.length > DASHBOARD_PREVIEW_LIMIT) ? (
            <button
              type="button"
              className="secondary board-show-all"
              aria-expanded={showAllCards}
              onClick={() => setShowAllCards((open) => !open)}
            >
              {showAllCards ? "Show fewer" : `Show all ${visible.length} previews`}
              <span aria-hidden="true">{showAllCards ? "↑" : "↓"}</span>
            </button>
          ) : null}

          <div className="board-toolbar">
            <div className="board-toolbar-main">
              <details className="advanced">
                <summary>
                  {dockerRuntime ? "Advanced: containers" : "Advanced: processes"}
                  {overview && overview.deployments.length > 0 ? (
                    <span className="advanced-count">{overview.deployments.length}</span>
                  ) : null}
                </summary>
                <p className="advanced-help">
                  {dockerRuntime
                    ? "Containers that are still listening on this machine."
                    : "Gate and app processes that are still listening on this machine."}
                </p>
                <div className="stack advanced-list">
                  {overview && overview.deployments.length === 0 ? (
                    <p className="empty">Nothing is listening. Closed, idle, and expired previews are gone.</p>
                  ) : null}
                  {overview?.deployments.map((deployment) => (
                    <article className="deployment" key={deployment.deploymentId}>
                      <div className="deployment-main">
                        <strong>
                          {deployment.repository}
                          <span> #{deployment.prNumber}</span>
                        </strong>
                        <p className="meta">
                          <span className="chip mono">{deployment.sha.slice(0, 8)}</span>
                          {deployment.port ? <span className="chip port-chip">port {deployment.port}</span> : null}
                        </p>
                      </div>
                      {config?.deployer === "fake" ? null : (
                        <a className="open-preview secondary" href={previewPath(deployment.url)}>
                          Open
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              </details>
              {polledAt != null ? (
                <p className="updated">Updated {Math.max(0, Math.floor((now - polledAt) / 1000))} s ago</p>
              ) : null}
            </div>

            {overview && removed.length > 0 ? (
              <button
                type="button"
                className="history-toggle secondary"
                aria-expanded={showRemoved}
                onClick={() => setShowRemoved((open) => !open)}
              >
                {showRemoved ? "Hide removed" : "Show removed"}
                <span>{removed.length}</span>
              </button>
            ) : null}
          </div>

          {showRemoved && removed.length > 0 ? (
            <div className="stack env-card-stack" data-view="list">
              {removed.map((env) => (
                <EnvironmentCard
                  key={env.id}
                  env={env}
                  now={now}
                  demo={config?.demo === `${env.repository}#${env.prNumber}`}
                  signedIn={signedIn}
                  busy={busy}
                  onAdminAction={(item, action) => void adminAction(item, action)}
                  onShowLifecycle={(item) => setLifecycleId(item.id)}
                />
              ))}
            </div>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
        </section>

        {expanded ? null : (
        <aside className="board-rail">
          <section className="board-rail-card" aria-label="Estimated cost and usage">
            <div className="board-rail-head">
              <h2 className="board-rail-title">Cost &amp; Usage</h2>
              <a className="board-rail-link" href="/cost">
                Details <span aria-hidden="true">→</span>
              </a>
            </div>
            <p className="savings-sub">
              {overview
                ? `Estimated always awake ${formatEstMoney(alwaysAwakeEstimate, currency)} · Estimated with Mayfly ${formatEstMoney(withMayflyEstimate, currency)}`
                : "Waiting for the first reaper sample…"}
            </p>
          </section>

          <section className="board-rail-card board-activity" aria-label="Recent activity">
            <div className="board-rail-head">
              <h2 className="board-rail-title">Recent activity</h2>
              <a className="board-rail-link" href="/activity">
                View all <span aria-hidden="true">→</span>
              </a>
            </div>
            {activity.length === 0 ? (
              <p className="empty">No activity yet.</p>
            ) : (
              <ol className="board-activity-list">
                {activity.map((item, index) => (
                  <li key={`${item.at}-${item.subject}-${item.type}-${index}`} data-tone={item.icon}>
                    <span className="board-activity-icon" aria-hidden="true">
                      <StateIcon name={item.icon} />
                    </span>
                    <span className="board-activity-text">
                      <strong>{item.subject}</strong> {item.label}
                      {item.repository ? <span className="board-activity-repo"> · {item.repository}</span> : null}
                    </span>
                    <time dateTime={item.at}>{formatAgo(item.at, now)}</time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
        )}
      </div>

      {config?.deployer === "fake" ? (
        <p className="footer">
          This site keeps the record. The preview itself runs on the computer where Mayfly is running.
        </p>
      ) : null}

      <LifecycleDrawer
        env={lifecycleEnv}
        demo={lifecycleEnv ? demoKey === `${lifecycleEnv.repository}#${lifecycleEnv.prNumber}` : false}
        onClose={() => setLifecycleId(null)}
      />
    </AppShell>
  );
}
