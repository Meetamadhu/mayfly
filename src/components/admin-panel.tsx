"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BackupsPanel } from "@/components/backups-panel";
import { ResourcesPanel } from "@/components/resources-panel";
import { Lifespan, OpenedBy, cardState, previewHref, statePillLabel } from "@/components/board-parts";
import { StateGlyph, repoAvatar } from "@/components/previews-view";
import { RecentActivitySheet } from "@/components/recent-activity-sheet";
import { READ_KEY, isUnread, readSince, recentItems } from "@/lib/recent-activity";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";
import { timelineLabel, timelineNewestFirst } from "@/lib/timeline";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;

// Hints and starting values for the simulator form: the sample app's pull request. Commit and branch start empty
// so Mayfly resolves them from the PR head on GitHub (a stale branch from another PR cannot stick around).
const SAMPLE = {
  repository: "meetamadhu/mayfly-sample-app",
  prNumber: "1",
  branch: "",
  sha: "",
};

function formatLifetime(hours: number) {
  if (hours >= 48) {
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day" : `${days} days`;
  }
  return `${hours} h`;
}



function stateNote(env: Environment) {
  if (env.status === "provisioning" || env.status === "updating") {
    return "Building this commit. This usually takes under a minute.";
  }
  if (env.status === "destroying") return "Removing this preview.";
  if (env.status === "failed") return "This preview couldn't be built. Open History to see why.";
  if (env.sleep === "asleep") return "Saving money while nobody's looking. Opening it wakes it up in a second or two.";
  if (env.sleep === "waking") return "Starting up…";
  return "Ready to look at.";
}

function formatAgo(iso: string, now: number) {
  const delta = now - Date.parse(iso);
  if (Number.isNaN(delta)) return iso;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return "just now";
  const hours = Math.floor(Math.abs(delta) / 3600000);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
  if (hours > 0) return rest ? `${hours} h ${rest} min ago` : `${hours} h ago`;
  return `${minutes} min ago`;
}


function formatLocalTime(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatAwakeUntil(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isLocalPreviewBase(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}

type ListTab = "all" | "awake" | "asleep" | "failed";

const LIST_TABS: { id: ListTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "awake", label: "Awake" },
  { id: "asleep", label: "Asleep" },
  { id: "failed", label: "Failed" },
];

function inListTab(env: Environment, tab: ListTab) {
  const state = cardState(env);
  if (tab === "awake") return state === "running";
  if (tab === "asleep") return state === "sleeping";
  if (tab === "failed") return state === "failed";
  return true;
}

export function AdminPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState(SAMPLE.repository);
  const [prNumber, setPrNumber] = useState(SAMPLE.prNumber);
  const [branch, setBranch] = useState(SAMPLE.branch);
  const [sha, setSha] = useState(SAMPLE.sha);
  const repositoryEdited = useRef(false);
  const [ttlMinutes, setTtlMinutes] = useState("");
  const [extendHours, setExtendHours] = useState("4");
  const [keepAwakeHours, setKeepAwakeHours] = useState<1 | 2 | 4 | 8>(1);
  const [activityOpen, setActivityOpen] = useState(false);
  const [readMs, setReadMs] = useState(() => Date.now());
  const [listTab, setListTab] = useState<ListTab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [plan, setPlan] = useState<{ name: string; used: number; limit: number | null } | null>(null);

  // The plan and how many previews it allows, for the Plan button in the toolbar.
  useEffect(() => {
    if (refreshing) return;
    let cancelled = false;
    void fetch("/api/plan", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ ok?: boolean; current?: { id: string }; plans?: { id: string; name: string; maxPreviews: number | null }[]; usage?: { previews: number } }>)
      .then((body) => {
        const current = body.ok ? body.plans?.find((item) => item.id === body.current?.id) : undefined;
        if (!cancelled && current) setPlan({ name: current.name, used: body.usage?.previews ?? 0, limit: current.maxPreviews });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshing]);
  const [now, setNow] = useState(() => Date.now());
  const defaultTtlLabel = overview ? formatLifetime(overview.config.ttlHours) : "server default";

  const reload = useCallback(async () => {
    const response = await fetch("/api/environments", { cache: "no-store", credentials: "include" });
    const body = (await response.json()) as Overview & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load environments.");
    setOverview(body);
    setLoadError(null);
    return body;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    async function tick() {
      try {
        const body = await reload();
        if (cancelled) return;
        const fast = body.environments.some(
          (env) => TRANSITIONAL.has(env.status) || (LIVE.has(env.status) && (env.sleep === "asleep" || env.sleep === "waking")),
        );
        const wait = fast ? FAST_POLL_MS : body.environments.some((env) => LIVE.has(env.status)) ? LIVE_POLL_MS : 0;
        if (wait) timer = window.setTimeout(() => void tick(), wait);
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "Could not load environments.");
      }
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reload, overview?.summary.live, overview?.environments.map((env) => `${env.id}:${env.status}:${env.sleep}`).join("|")]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // When this device last marked the activity read (kept in this browser only).
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(READ_KEY);
    } catch {
      // Storage can be blocked; everything from the last day counts as new.
    }
    setReadMs(readSince(stored, Date.now()));
  }, []);

  function markAllRead() {
    const at = new Date().toISOString();
    try {
      localStorage.setItem(READ_KEY, at);
    } catch {
      // Not remembered after a reload, but cleared for now.
    }
    setReadMs(Date.parse(at));
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await reload();
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Could not load environments.");
    } finally {
      setRefreshing(false);
    }
  }

  async function readBody(response: Response) {
    const body = (await response.json()) as { error?: string };
    if (response.status === 401) {
      window.location.assign("/admin/login");
      throw new Error("Your sign-in ran out. Please sign in again.");
    }
    if (!response.ok) throw new Error(body.error || `Something went wrong (error ${response.status}). Please try again.`);
    return body;
  }

  async function send(
    action: "opened" | "synchronize" | "closed" | "reopened",
    overrides?: { sha?: string; merged?: boolean },
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        action,
        repository,
        prNumber: Number(prNumber),
        sha: overrides?.sha ?? sha,
        branch,
        merged: overrides?.merged ?? false,
        wait: true,
      };
      if (ttlMinutes.trim() !== "") {
        body.ttlMinutes = Number(ttlMinutes);
      }
      const response = await fetch("/api/events", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await readBody(response);
      setNotice(action === "opened" ? "Preview opened." : null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sleepNow(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/environments/${id}?action=sleep`, { method: "POST", credentials: "include" });
      await readBody(response);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function extend(env: Environment) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/environments/${env.id}?action=extend&hours=${encodeURIComponent(extendHours)}`,
        { method: "POST", credentials: "include" },
      );
      const body = (await readBody(response)) as { environment: Environment };
      setNotice(`Extended. New expiry ${body.environment.expiresAt}.`);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function keepAwake(env: Environment, hours: 1 | 2 | 4 | 8) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/environments/${env.id}?action=keep_awake&hours=${hours}`,
        { method: "POST", credentials: "include" },
      );
      const body = (await readBody(response)) as { environment: Environment };
      const until = body.environment.keepAwakeUntil;
      setNotice(until ? `Kept awake until ${formatAwakeUntil(until)}.` : "Kept awake.");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function keepAwakeOff(env: Environment) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/environments/${env.id}?action=keep_awake_off`, {
        method: "POST",
        credentials: "include",
      });
      await readBody(response);
      setNotice("Stopped keeping awake.");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy(env: Environment) {
    if (!window.confirm(`Remove the preview for ${env.repository} #${env.prNumber}? Its link will stop working.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/environments/${env.id}?action=destroy&wait=1`, {
        method: "POST",
        credentials: "include",
      });
      await readBody(response);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runReaper() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/reaper", { method: "POST", credentials: "include" });
      const body = (await readBody(response)) as { destroyed: Environment[]; failed: { error: string }[] };
      if (body.failed.length > 0) setError(body.failed.map((item) => item.error).join(" "));
      else if (body.destroyed.length > 0)
        setNotice(`Cleaned up ${body.destroyed.length} preview${body.destroyed.length === 1 ? "" : "s"} whose time had run out.`);
      else setNotice("Nothing needed cleaning up.");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Clean-up didn't finish. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    window.location.assign("/admin/login");
  }

  const config = overview?.config;
  const allowed = config?.allowedRepositories;
  const firstAllowed = allowed?.[0];

  // Start from the first repository Mayfly may build, unless the person has already typed one.
  useEffect(() => {
    if (firstAllowed && !repositoryEdited.current) setRepository(firstAllowed);
  }, [firstAllowed]);

  const demoKey = config?.demo ?? "";
  const rows = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const activity = overview ? recentItems(overview.environments, demoKey || null) : [];
  const unread = activity.filter((item) => isUnread(item, readMs)).length;
  const listed = rows.filter((env) => inListTab(env, listTab));
  const setupIssues = config
    ? (config.webhookVerification === "signed" ? 0 : 1) + (isLocalPreviewBase(config.previewBaseUrl) ? 1 : 0)
    : 0;
  const envFile = config?.onRender ? "Render → Environment" : ".env.local";
  const envLines = [
    config && config.webhookVerification !== "signed" ? "GITHUB_WEBHOOK_SECRET=…" : null,
    config && isLocalPreviewBase(config.previewBaseUrl) ? "PREVIEW_BASE_URL=https://…" : null,
  ].filter(Boolean) as string[];

  return (
    <AppShell active="admin" githubConnected={Boolean(config?.githubConnected)} onSignOut={signOut}>
      <div className="admin-panel admin-in-shell">
      <section className="board-welcome page-head-inline">
        <div>
          <h1 className="title-in-header">Admin</h1>
          <p className="lede">Look after every preview by hand, and try out pull requests without going to GitHub.</p>
        </div>
      </section>

      <div className="adm-toolbar">
        <button type="button" className="adm-tool" onClick={() => setActivityOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
            <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
          </svg>
          Recent activity
          {unread > 0 ? (
            <span className="adm-badge">
              {unread > 99 ? "99+" : unread}
              <span className="visually-hidden"> new</span>
            </span>
          ) : null}
        </button>
        <button type="button" className="adm-tool" disabled={refreshing} onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-spin={refreshing ? "1" : undefined}>
            <path d="M20 12a8 8 0 1 1-2.34-5.66" />
            <path d="M20 4v5h-5" />
          </svg>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {plan ? (
          <a className="adm-tool adm-plan" href="/pricing">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7z" />
              <circle cx="8" cy="8" r="1.6" />
            </svg>
            {plan.name} plan
            <span className="adm-plan-use">{plan.limit === null ? `${plan.used} previews` : `${plan.used} of ${plan.limit} previews`}</span>
          </a>
        ) : null}
      </div>

      {setupIssues > 0 ? (
        <a className="adm-banner" href="#setup-check">
          <span className="adm-banner-icon" aria-hidden="true">
            !
          </span>
          <span className="adm-banner-text">
            <strong>Setup needs attention</strong>
            <span>
              {setupIssues} setting{setupIssues === 1 ? "" : "s"} to fix
            </span>
          </span>
          <span className="adm-banner-go">Review ›</span>
        </a>
      ) : null}

      <section className="panel" aria-label="Previews">
        <div className="ledger-head">
          <div>
            <h2>
              Previews {overview ? <span className="adm-count">{rows.length}</span> : null}
            </h2>
            <p className="help">Everything running now, plus any that failed to build. You&apos;ll always be asked before a preview is removed.</p>
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="adm-tabs" role="tablist" aria-label="Show previews">
            {LIST_TABS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={listTab === item.id} onClick={() => setListTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        {rows.length > 0 && listed.length === 0 ? <p className="empty">No previews here right now.</p> : null}
        {loadError ? <p className="error" role="alert">{loadError}</p> : null}
        {!overview && !loadError ? <p className="empty">Loading previews…</p> : null}
        {overview && rows.length === 0 ? <p className="empty">Nothing is running right now.</p> : null}
        {listed.length > 0 ? (
          <ul className="preview-list">
            {listed.map((env) => {
              const demo = demoKey === `${env.repository}#${env.prNumber}`;
              const canSleep = env.status === "ready" && env.sleep === "awake";
              const canKeepAwake = env.status === "ready" || env.status === "updating";
              const awakeUntil =
                env.keepAwakeUntil && Date.parse(env.keepAwakeUntil) > now ? env.keepAwakeUntil : null;
              const pillState = cardState(env);
              const timeline = timelineNewestFirst(env.events);
              const avatar = repoAvatar(env.repository);
              return (
                <li key={env.id} className="env adm-card" data-state={pillState}>
                  <header className="adm-card-head">
                    <span className="pv-avatar" data-tone={avatar.tone} aria-hidden="true">
                      {avatar.letter}
                    </span>
                    <div className="adm-card-title">
                      <h3>{demo ? "Demo preview" : `PR #${env.prNumber}`}</h3>
                      <span className="card-repo">{env.repository}</span>
                    </div>
                    <span className="state-pill" data-state={pillState}>
                      {statePillLabel(pillState)}
                    </span>
                  </header>
                  {demo ? null : <p className="adm-branch mono">{env.branch}</p>}
                  <p className="adm-note">
                    {stateNote(env)}
                    {awakeUntil ? ` Kept awake until ${formatAwakeUntil(awakeUntil)}.` : ""}
                  </p>
                  <Lifespan env={env} now={now} demo={demo} />
                  <p className="adm-facts">
                    <span>
                      <OpenedBy env={env} />
                      {demo ? null : (
                        <>
                          Commit <span className="mono">{env.sha.slice(0, 7)}</span>
                        </>
                      )}
                    </span>
                    <span>Last visited {formatAgo(env.lastActiveAt, now)}</span>
                  </p>
                  <div className="adm-actions">
                    {env.url ? (
                      <a className="adm-btn adm-btn-main" href={previewHref(env.url, { from: "admin" })} target="_blank" rel="noopener noreferrer">
                        Open preview <span aria-hidden="true">↗</span>
                        <span className="visually-hidden"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <button type="button" className="adm-btn adm-btn-main" disabled>
                        Open preview
                      </button>
                    )}
                    {canSleep ? (
                      <button type="button" className="adm-btn" disabled={busy} onClick={() => void sleepNow(env.id)}>
                        Put to sleep
                      </button>
                    ) : null}
                    {awakeUntil ? (
                      <button type="button" className="adm-btn" disabled={busy} onClick={() => void keepAwakeOff(env)}>
                        Stop keeping awake
                      </button>
                    ) : (
                      <span className="adm-split">
                        <button
                          type="button"
                          className="adm-btn"
                          disabled={busy || !canKeepAwake}
                          onClick={() => void keepAwake(env, keepAwakeHours)}
                        >
                          Keep awake
                        </button>
                        <select
                          aria-label="Keep awake for"
                          value={keepAwakeHours}
                          disabled={busy || !canKeepAwake}
                          onChange={(event) => setKeepAwakeHours(Number(event.target.value) as 1 | 2 | 4 | 8)}
                        >
                          <option value={1}>1h</option>
                          <option value={2}>2h</option>
                          <option value={4}>4h</option>
                          <option value={8}>8h</option>
                        </select>
                      </span>
                    )}
                    <span className="adm-split">
                      <button type="button" className="adm-btn" disabled={busy || demo} onClick={() => void extend(env)}>
                        Extend
                      </button>
                      <select
                        aria-label="Extend by"
                        value={extendHours}
                        disabled={busy || demo}
                        onChange={(event) => setExtendHours(event.target.value)}
                      >
                        <option value="2">2h</option>
                        <option value="4">4h</option>
                        <option value="12">12h</option>
                        <option value="24">24h</option>
                      </select>
                    </span>
                  </div>
                  <footer className="adm-card-foot">
                    <details className="adm-history">
                      <summary>History</summary>
                      {timeline.length === 0 ? (
                        <p className="env-timeline-empty">Nothing has happened yet</p>
                      ) : (
                        <ol className="env-timeline-list">
                          {timeline.map((event, index) => (
                            <li key={`${event.at}-${event.type}-${index}`}>
                              <time dateTime={event.at}>{formatLocalTime(event.at)}</time>
                              <span>{timelineLabel(event)}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </details>
                    <button type="button" className="adm-remove" disabled={busy || env.status === "destroying"} onClick={() => void destroy(env)}>
                      Remove
                    </button>
                  </footer>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
      </section>

      <div className="workspace">
        <details id="simulator" className="panel simulator" open>
          <summary>
            Try a pull request <span className="adm-chip" data-tone="ok">Practice mode</span>
          </summary>
          <p className="help">
            Pretend to be GitHub: open, update, close or merge a pull request and watch what Mayfly does. Real pull requests arrive at <span className="mono">/api/webhooks/github</span>.
          </p>
          <article className="sim-pr-card" aria-label="Pull request draft">
            <header className="sim-pr-band">
              <span className="sim-pr-open">Open</span>
              <div className="sim-pr-title">
                <p className="sim-pr-repo">{repository || SAMPLE.repository}</p>
                <h3>
                  #{prNumber || SAMPLE.prNumber}
                  <span className="sim-pr-sep"> · </span>
                  <span className="mono">{branch.trim() || "PR head"}</span>
                </h3>
              </div>
            </header>
            <div className="sim-pr-body">
              <p className="meta meta-facts">
                <span className="fact-pill" data-fact="branch">
                  <span className="fact-label">Branch</span>
                  <span className="fact-value mono">{branch.trim() || "PR head"}</span>
                </span>
                <span className="fact-pill" data-fact="visit">
                  <span className="fact-label">Commit</span>
                  <span className="fact-value mono">{sha.trim() ? sha.trim().slice(0, 8) : "latest"}</span>
                </span>
                <span className="fact-pill" data-fact="expires">
                  <span className="fact-label">Lifetime</span>
                  <span className="fact-value">
                    {ttlMinutes === "0" ? "expire now" : ttlMinutes.trim() ? `${ttlMinutes} m` : defaultTtlLabel}
                  </span>
                </span>
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void send("opened");
                }}
              >
                <label>
                  Repository
                  <input
                    value={repository}
                    onChange={(event) => {
                      repositoryEdited.current = true;
                      setRepository(event.target.value);
                    }}
                    placeholder={SAMPLE.repository}
                    required
                  />
                  {allowed !== undefined ? (
                    <small className="field-note">
                      {allowed === null
                        ? "Allowed: any (process mode)"
                        : allowed.length > 0
                          ? `Allowed: ${allowed.join(", ")}`
                          : "Allowed: none (set PREVIEW_REPOS)"}
                    </small>
                  ) : null}
                </label>
                <label>
                  Pull request
                  <input
                    value={prNumber}
                    onChange={(event) => {
                      setPrNumber(event.target.value);
                      setBranch("");
                    }}
                    placeholder={SAMPLE.prNumber}
                    inputMode="numeric"
                    required
                  />
                </label>
                <label>
                  Branch
                  <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="Empty = PR head branch"
                  />
                </label>
                <label>
                  Commit
                  <input
                    value={sha}
                    onChange={(event) => setSha(event.target.value)}
                    placeholder="Empty = latest commit of the PR"
                    className="mono"
                  />
                </label>
                <label>
                  Lifetime (minutes)
                  <input
                    value={ttlMinutes}
                    onChange={(event) => setTtlMinutes(event.target.value)}
                    inputMode="numeric"
                    min={0}
                    max={10080}
                    placeholder={`default: ${defaultTtlLabel}`}
                  />
                </label>
                <p className="help">Leave empty for the usual lifetime. Enter 0 to make it run out straight away, then press Clean up to see it removed.</p>
                <div className="actions">
                  <button type="submit" disabled={busy}>Open PR</button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void send("synchronize", { sha: "" })}
                  >
                    Push commit
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed")}>
                    Close
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed", { merged: true })}>
                    Merge
                  </button>
                  <button type="button" className="secondary sim-cleanup" disabled={busy} onClick={() => void runReaper()}>
                    Clean up
                  </button>
                </div>
              </form>
            </div>
          </article>
        </details>

        <section className="panel config-check adm-setup" id="setup-check" aria-label="Setup check">
          <div className="adm-setup-head">
            <h2>Setup check</h2>
            {config ? (
              <span className="adm-chip" data-tone={setupIssues > 0 ? "warn" : "ok"}>
                {setupIssues > 0 ? `${setupIssues} to fix` : "All good"}
              </span>
            ) : null}
          </div>
          <p className="help">Two settings worth checking before real pull requests arrive.</p>
          {config ? (
            <ul className="adm-checks">
              <li data-tone={config.webhookVerification === "signed" ? "ok" : "bad"}>
                <span className="adm-check-icon" aria-hidden="true">
                  <StateGlyph tone={config.webhookVerification === "signed" ? "awake" : "failed"} />
                </span>
                <div>
                  <strong>Messages from GitHub</strong>
                  <span className="adm-chip" data-tone={config.webhookVerification === "signed" ? "ok" : "bad"}>
                    {config.webhookVerification === "signed" ? "Verified" : "Not verified"}
                  </span>
                  <p>
                    {config.webhookVerification === "signed"
                      ? "Mayfly checks that each message really comes from GitHub."
                      : "Anyone could pretend to be GitHub. Set GITHUB_WEBHOOK_SECRET to the webhook's secret."}
                  </p>
                </div>
              </li>
              <li data-tone={isLocalPreviewBase(config.previewBaseUrl) ? "warn" : "ok"}>
                <span className="adm-check-icon" aria-hidden="true">
                  {isLocalPreviewBase(config.previewBaseUrl) ? "!" : <StateGlyph tone="awake" />}
                </span>
                <div>
                  <strong>Public address</strong>
                  <span className="adm-url mono">{config.previewBaseUrl}</span>
                  <p>
                    {isLocalPreviewBase(config.previewBaseUrl)
                      ? "Local address, so links in PR comments won't work for anyone else."
                      : "Links in PR comments use this address."}
                  </p>
                </div>
              </li>
            </ul>
          ) : (
            <p className="help">Checking…</p>
          )}
          {config && envLines.length > 0 ? (
            <div className="adm-code">
              <div className="adm-code-head">
                <span># {envFile}</span>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(envLines.join("\n")).catch(() => undefined)}
                >
                  Copy
                </button>
              </div>
              <pre>{envLines.join("\n")}</pre>
              <p>{config.onRender ? "then save, and Render restarts Mayfly" : "then restart Mayfly"}</p>
            </div>
          ) : null}
        </section>

        <ResourcesPanel environments={rows} />

        <BackupsPanel />
      </div>

      <RecentActivitySheet
        open={activityOpen}
        items={activity}
        now={now}
        readMs={readMs}
        onMarkRead={markAllRead}
        onClose={() => setActivityOpen(false)}
      />
      </div>
    </AppShell>
  );
}
