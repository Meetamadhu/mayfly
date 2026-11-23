"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  EnvironmentCard,
  LifecycleDrawer,
  formatLifetime,
  formatSleep,
  authorOf,
  matchesBoardAuthor,
  matchesBoardFilter,
  matchesBoardSearch,
  previewPath,
  type BoardFilter,
} from "@/components/board-parts";
import {
  Popover,
  PreviewStats,
  PreviewsTable,
  PreviewTabs,
  SORT_LABELS,
  TABS,
  sortPreviews,
  type PreviewSort,
} from "@/components/previews-view";
import type { Environment } from "@/lib/types";
import { useOverview } from "@/lib/use-overview";
import { useResources } from "@/lib/use-resources";

const VIEW_KEY = "mayfly-previews-view";
const SORT_KEY = "mayfly-previews-sort";

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key) as T | null;
    if (raw && allowed.includes(raw)) return raw;
  } catch {
    // Storage can be blocked.
  }
  return fallback;
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the choice still applies on this page.
  }
}

/** "6 pull requests across 2 repos" */
function countLine(list: Environment[]) {
  const repos = new Set(list.map((env) => env.repository)).size;
  if (list.length === 0) return "No pull requests have a preview right now.";
  return `${list.length} pull request${list.length === 1 ? "" : "s"} across ${repos} repo${repos === 1 ? "" : "s"}.`;
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
  const [view, setView] = useState<"table" | "cards">("table");
  const [sort, setSort] = useState<PreviewSort>("visit");
  const [busy, setBusy] = useState(false);
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);

  useEffect(() => {
    setView(readPref(VIEW_KEY, ["table", "cards"] as const, "table"));
    setSort(readPref(SORT_KEY, ["visit", "newest", "expiring"] as const, "visit"));
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

  function chooseView(next: "table" | "cards") {
    setView(next);
    writePref(VIEW_KEY, next);
  }

  function chooseSort(next: PreviewSort) {
    setSort(next);
    writePref(SORT_KEY, next);
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
  const costPerHour = overview?.costPerHour ?? 0.05;
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const demoKey = config?.demo ?? null;
  const matching = current.filter((env) => matchesBoardSearch(env, boardQuery) && matchesBoardAuthor(env, boardAuthor));
  const visible = sortPreviews(
    matching.filter((env) => matchesBoardFilter(env, boardFilter, now, demoKey)),
    sort,
  );
  const tabCounts = Object.fromEntries(
    TABS.map(([id]) => [id, matching.filter((env) => matchesBoardFilter(env, id, now, demoKey)).length]),
  ) as Partial<Record<BoardFilter, number>>;
  // Everyone who has a preview up, with how many, for the "Opened by" filter.
  const authorCounts = new Map<string, number>();
  for (const env of current) {
    const login = authorOf(env);
    if (login) authorCounts.set(login, (authorCounts.get(login) ?? 0) + 1);
  }
  const authors = [...authorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Keep a person picked from a link in the menu even when they have nothing up right now.
  if (boardAuthor && !authorCounts.has(boardAuthor)) authors.unshift([boardAuthor, 0]);
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  const dockerRuntime = config?.allowedRepositories != null;
  const lifecycleEnv = lifecycleId ? (overview?.environments.find((env) => env.id === lifecycleId) ?? null) : null;
  const owners = [...new Set(current.map((env) => env.repository.split("/")[0]))];
  const filtersOn = (boardAuthor ? 1 : 0) + (view === "cards" ? 1 : 0);

  return (
    <AppShell
      active="dashboard"
      githubConnected={Boolean(config?.githubConnected)}
      crumb={owners.length === 1 ? owners[0] : undefined}
      previewCount={overview ? current.length : undefined}
      search={{ value: boardQuery, onChange: setBoardQuery, placeholder: "Search repo, branch or person" }}
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

      <header className="pv-head">
        <div className="pv-head-text">
          <h1 className="title-in-header">Previews</h1>
          <p className="pv-lede" aria-live="polite">
            {overview ? `${countLine(current)} ` : "Loading previews… "}
            {config
              ? `Idle previews fall asleep after ${formatSleep(config.sleepSeconds)} and cost nothing; each lasts up to ${formatLifetime(config.ttlHours)}.`
              : ""}
            {config?.privatePreviews ? " Preview links ask for the team password." : ""}
          </p>
        </div>
        <div className="pv-head-actions">
          {signedIn ? (
            <a className="pv-btn" href="/admin#simulator">
              Try a pull request
            </a>
          ) : null}
          <Popover
            label={
              <>
                Filters{filtersOn > 0 ? <span className="pv-badge">{filtersOn}</span> : null}
              </>
            }
          >
            {() => (
              <div className="pv-filters">
                <label className="pv-field">
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
                <fieldset className="pv-field">
                  <legend>Show as</legend>
                  <div className="pv-seg" role="group">
                    <button type="button" aria-pressed={view === "table"} onClick={() => chooseView("table")}>
                      Table
                    </button>
                    <button type="button" aria-pressed={view === "cards"} onClick={() => chooseView("cards")}>
                      Cards
                    </button>
                  </div>
                </fieldset>
                {filtersOn > 0 ? (
                  <button
                    type="button"
                    className="pv-link"
                    onClick={() => {
                      pickAuthor(null);
                      chooseView("table");
                    }}
                  >
                    Reset
                  </button>
                ) : null}
              </div>
            )}
          </Popover>
          <Popover label={<>Sort: {SORT_LABELS[sort]}</>}>
            {(close) => (
              <div className="pv-sort" role="menu">
                {(Object.keys(SORT_LABELS) as PreviewSort[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sort === id}
                    onClick={() => {
                      chooseSort(id);
                      close();
                    }}
                  >
                    {SORT_LABELS[id]}
                  </button>
                ))}
              </div>
            )}
          </Popover>
        </div>
      </header>

      <PreviewStats overview={overview ?? null} current={current} now={now} />

      <PreviewTabs value={boardFilter} counts={tabCounts} onChange={setBoardFilter} />
      {boardAuthor ? (
        <p className="pv-filter-note">
          Showing @{boardAuthor}&apos;s previews.{" "}
          <button type="button" className="pv-link" onClick={() => pickAuthor(null)}>
            Show everyone&apos;s
          </button>
        </p>
      ) : null}

      {loadError ? <p className="error" role="alert">{loadError}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}

      {overview && current.length === 0 ? (
        <p className="pv-empty">No previews yet. Open a pull request on GitHub and its preview will appear here.</p>
      ) : overview && visible.length === 0 ? (
        <p className="pv-empty">Nothing matches. Try another tab, filter or search.</p>
      ) : view === "table" && visible.length > 0 ? (
        <PreviewsTable
          previews={visible}
          demoKey={demoKey}
          now={now}
          signedIn={signedIn}
          busy={busy}
          currency={currency}
          costPerHour={costPerHour}
          measured={Boolean(resources?.previews)}
          resourcesFor={(env) => (env.deploymentId ? resources?.previews?.[env.deploymentId] : undefined)}
          onAdminAction={(item, action) => void adminAction(item, action)}
          onShowHistory={(item) => setLifecycleId(item.id)}
          onPickAuthor={pickAuthor}
        />
      ) : (
        <div className="stack env-card-stack" data-view="grid">
          {visible.map((env) => (
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
      )}

      <div className="board-toolbar pv-toolbar">
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
