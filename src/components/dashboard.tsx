"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  EnvironmentCard,
  LifecycleDrawer,
  StateIcon,
  boardRecentActivity,
  estimatedCost,
  formatAgo,
  formatEstMoney,
  formatLifetime,
  formatSaved,
  formatSleep,
  authorOf,
  matchesBoardAuthor,
  matchesBoardFilter,
  matchesBoardSearch,
  previewPath,
  readStoredView,
  writeStoredView,
  type BoardFilter,
} from "@/components/board-parts";
import type { Environment } from "@/lib/types";
import { useOverview } from "@/lib/use-overview";
import { useResources } from "@/lib/use-resources";

const DASHBOARD_PREVIEW_LIMIT = 2;

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

function countWord(n: number, capital = true) {
  const word = NUMBER_WORDS[n] ?? String(n);
  return capital ? word : word.toLowerCase();
}

/** The dashboard's headline: what is up right now, said the way a person would say it. */
function boardHeadline(
  counts: { live: number; awake: number; asleep: number; building: number; capacity: number } | null,
) {
  if (!counts) return "Checking on your previews…";
  const { live, awake, asleep, building, capacity } = counts;
  if (live === 0) return "No previews are up right now.";
  const first = `${countWord(live)} preview${live === 1 ? " is" : "s are"} up${live >= capacity && capacity > 0 ? ", the most Mayfly allows" : ""}.`;
  if (live > 1 && (awake === live || asleep === live || building === live)) {
    const all = awake === live ? "awake" : asleep === live ? "asleep" : "building";
    return `${first.slice(0, -1)}, ${live === 2 ? "both" : "all of them"} ${all}.`;
  }
  const parts = [
    awake ? `${countWord(awake, false)} awake` : "",
    asleep ? `${countWord(asleep, false)} asleep` : "",
    building ? `${countWord(building, false)} building` : "",
  ].filter(Boolean);
  if (parts.length === 0) return first;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${first} ${list.charAt(0).toUpperCase()}${list.slice(1)}.`;
}

export function Dashboard() {
  const { overview, loadError, polledAt, now, reload } = useOverview();
  const resources = useResources(15_000);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [boardQuery, setBoardQuery] = useState("");
  const [boardAuthor, setBoardAuthor] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [cardView, setCardView] = useState<"grid" | "list">("grid");
  const [busy, setBusy] = useState(false);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);
  const [showAllCards, setShowAllCards] = useState(false);

  useEffect(() => {
    setCardView(readStoredView());
    // Searches started from another page arrive as /board?q=…
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) setBoardQuery(q);
    // /board?by=<github login> opens straight to one person's previews, so the link can be shared.
    const by = params.get("by")?.trim().toLowerCase().replace(/^@/, "");
    if (by && /^[a-z0-9-]{1,39}$/.test(by)) setBoardAuthor(by);
  }, []);

  function pickAuthor(login: string | null) {
    setBoardAuthor(login);
    try {
      const url = new URL(window.location.href);
      if (login) url.searchParams.set("by", login);
      else url.searchParams.delete("by");
      window.history.replaceState(null, "", url);
    } catch {
      // The filter still applies; only the address bar isn't updated.
    }
  }

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
    if (action === "destroy" && !window.confirm(`Remove the preview for ${env.repository} #${env.prNumber}? Its link will stop working.`)) return;
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
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const config = overview?.config;
  const currency = overview?.currency ?? config?.currency ?? "$";
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const demoKey = config?.demo ?? null;
  const visible = current.filter(
    (env) =>
      matchesBoardFilter(env, boardFilter, now, demoKey) &&
      matchesBoardSearch(env, boardQuery) &&
      matchesBoardAuthor(env, boardAuthor),
  );
  // Everyone who has a preview up, with how many, for the "Opened by" menu.
  const authorCounts = new Map<string, number>();
  for (const env of current) {
    const login = authorOf(env);
    if (login) authorCounts.set(login, (authorCounts.get(login) ?? 0) + 1);
  }
  const authors = [...authorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Keep a person picked from a link in the menu even when they have nothing up right now.
  if (boardAuthor && !authorCounts.has(boardAuthor)) authors.unshift([boardAuthor, 0]);
  // The Dashboard shows two previews; the rest sit behind "Show all". Searching or filtering shows every match.
  const narrowing = boardFilter !== "all" || boardQuery.trim() !== "" || boardAuthor !== null;
  const shown = showAllCards || narrowing ? visible : visible.slice(0, DASHBOARD_PREVIEW_LIMIT);
  const hiddenCount = visible.length - shown.length;
  // "Show all" gives the previews the whole width: the Cost & Usage and Recent activity cards step aside.
  const expanded = showAllCards && !narrowing && visible.length > DASHBOARD_PREVIEW_LIMIT;
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  const dockerRuntime = config?.allowedRepositories != null;
  const liveCount = overview?.summary.live ?? 0;
  const capacity = config?.maxConcurrent ?? 0;
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
      search={{ value: boardQuery, onChange: setBoardQuery, placeholder: "Search repo, branch or @person" }}
    >
      {config?.deployer === "fake" ? (
        <p className="notice" role="status">
          Demo mode: previews are listed here but not actually started.
          {process.env.NEXT_PUBLIC_LIVE_DEMO_URL ? (
            <>
              {" "}
              <a href={process.env.NEXT_PUBLIC_LIVE_DEMO_URL}>Open the live demo</a>
            </>
          ) : null}
        </p>
      ) : null}

      <section className="board-hero" aria-live="polite">
        <h1 className="board-headline">{boardHeadline(overview ? { live: liveCount, awake: overview.summary.awake, asleep: overview.summary.asleep, building: buildingCount, capacity } : null)}</h1>
        <p className="board-subline">
          {overview && overview.savedEstimate >= 0.01
            ? `Sleeping has saved about ${formatSaved(overview.savedEstimate, currency).replace("≈ ", "")} this month. `
            : ""}
          {config
            ? `Previews fall asleep after ${formatSleep(config.sleepSeconds)} without visitors and last up to ${formatLifetime(config.ttlHours)}.`
            : ""}
        </p>
        {signedIn ? (
          <a className="btn secondary board-hero-action" href="/admin#simulator">
            Try a pull request
          </a>
        ) : null}
      </section>

      <div className="board-workspace" data-expanded={expanded ? "true" : "false"}>
        <section className="live-column">
          <div className="ledger-head board-env-head">
            <h2>Previews</h2>
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
                  aria-label={label}
                  onClick={() => setBoardFilter(id)}
                >
                  {id === "expiring" ? (
                    <>
                      Expiring<span className="pill-long">{"\u00a0"}soon</span>
                    </>
                  ) : (
                    label
                  )}
                </button>
              ))}
            </div>
            {authors.length > 0 ? (
              <label className="board-author-filter">
                <span>Opened by</span>
                <select value={boardAuthor ?? ""} onChange={(event) => pickAuthor(event.target.value || null)}>
                  <option value="">Everyone</option>
                  {authors.map(([login, count]) => (
                    <option key={login} value={login}>
                      @{login} ({count})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="board-view-toggle" role="group" aria-label="Card layout">
              <button type="button" aria-pressed={cardView === "grid"} onClick={() => chooseCardView("grid")}>
                Grid
              </button>
              <button type="button" aria-pressed={cardView === "list"} onClick={() => chooseCardView("list")}>
                List
              </button>
            </div>
          </div>

          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="empty">Loading previews…</p> : null}

          <div className="stack env-card-stack" data-view={cardView}>
            {overview && current.length === 0 ? (
              <p className="empty">No previews yet. Open a pull request on GitHub and its preview will appear here.</p>
            ) : null}
            {overview && current.length > 0 && visible.length === 0 ? (
              <p className="empty">Nothing matches. Try another filter or search.</p>
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
                onPickAuthor={pickAuthor}
                resources={env.deploymentId ? resources?.previews?.[env.deploymentId] : undefined}
                measured={Boolean(resources?.previews)}
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
                  Behind the scenes
                  {overview && overview.deployments.length > 0 ? (
                    <span className="advanced-count">{overview.deployments.length}</span>
                  ) : null}
                </summary>
                <p className="advanced-help">
                  {dockerRuntime
                    ? "The containers running on the server right now, one per preview."
                    : "The programs running on the server right now, one per preview."}
                </p>
                <div className="stack advanced-list">
                  {overview && overview.deployments.length === 0 ? (
                    <p className="empty">Nothing is running. Closed and expired previews have been cleaned up.</p>
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
              <h2 className="board-rail-title">Cost this month</h2>
              <a className="board-rail-link" href="/cost">
                Details
              </a>
            </div>
            <p className="savings-sub">
              {overview
                ? alwaysAwakeEstimate < 0.01
                  ? "Less than a cent so far this month."
                  : `About ${formatEstMoney(withMayflyEstimate, currency)} with Mayfly, instead of ${formatEstMoney(alwaysAwakeEstimate, currency)} if every preview stayed on.`
                : "The first numbers appear about a minute after start-up."}
            </p>
          </section>

          <section className="board-rail-card board-activity" aria-label="Recent activity">
            <div className="board-rail-head">
              <h2 className="board-rail-title">Recent activity</h2>
              <a className="board-rail-link" href="/activity">
                View all
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
                      <strong>{item.subject}</strong>
                      {item.repository ? <span className="board-activity-repo"> in {item.repository}</span> : null}{" "}
                      {item.label}
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
          This site only keeps the list. The previews themselves run on the server where Mayfly is installed.
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
