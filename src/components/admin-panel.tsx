"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Lifespan, cardState, statePillLabel } from "@/components/board-parts";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";
import { removedLabel, timelineLabel, timelineNewestFirst } from "@/lib/timeline";

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

function previewPath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function formatDelta(iso: string, now = Date.now()) {
  const delta = Date.parse(iso) - now;
  if (Number.isNaN(delta)) return iso;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60000);
  if (minutes < 1) return delta >= 0 ? "now" : "just now";
  const hours = Math.floor(abs / 3600000);
  const rest = minutes % 60;
  const text =
    hours >= 48
      ? `${Math.floor(hours / 24)} d ${hours % 24} h`
      : hours > 0
        ? `${hours}h ${rest}m`
        : `${minutes}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

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

type Activity = { at: string; repository: string; prNumber: number; text: string };

function describeActivity(text: string) {
  const lower = text.toLowerCase();
  if (lower === "created") return { tone: "ready", label: "Created", detail: null };
  if (lower === "updated") return { tone: "work", label: "Updated", detail: null };
  if (lower === "last visit") return { tone: "asleep", label: "Visit", detail: null };
  if (lower.startsWith("removed")) {
    const reason = text.replace(/^Removed\s*/i, "").replace(/^\((.*)\)$/, "$1").trim();
    return { tone: "failed", label: "Removed", detail: reason || null };
  }
  if (lower.startsWith("preview ready:") || lower.startsWith("preview updated:")) {
    const raw = text.slice(text.indexOf(":") + 1).trim();
    let detail = raw;
    try {
      detail = new URL(raw).pathname;
    } catch {
      detail = raw;
    }
    return { tone: lower.startsWith("preview ready:") ? "ready" : "work", label: lower.startsWith("preview ready:") ? "Ready" : "Updated", detail };
  }
  const destroyed = /^Preview destroyed \(([^)]+)\)/i.exec(text);
  if (destroyed) return { tone: "failed", label: "Removed", detail: destroyed[1] };
  return { tone: "note", label: "Note", detail: text };
}

function recentActivity(environments: Environment[]) {
  const events: Activity[] = [];
  for (const env of environments) {
    events.push({ at: env.createdAt, repository: env.repository, prNumber: env.prNumber, text: "Created" });
    if (env.lastActiveAt && env.lastActiveAt !== env.createdAt) {
      events.push({ at: env.lastActiveAt, repository: env.repository, prNumber: env.prNumber, text: "Last visit" });
    }
    if (env.updatedAt && env.updatedAt !== env.createdAt && env.updatedAt !== env.lastActiveAt) {
      events.push({ at: env.updatedAt, repository: env.repository, prNumber: env.prNumber, text: "Updated" });
    }
    if (env.destroyedAt) {
      const reason = removedLabel(env.destroyReason);
      events.push({ at: env.destroyedAt, repository: env.repository, prNumber: env.prNumber, text: reason });
    }
    for (const comment of env.comments) {
      events.push({
        at: comment.at,
        repository: env.repository,
        prNumber: env.prNumber,
        text: comment.body.split("\n")[0],
      });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20);
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
  const [keepAwakeHours, setKeepAwakeHours] = useState<1 | 4 | 8>(1);
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

  async function keepAwake(env: Environment, hours: 1 | 4 | 8) {
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
  const activity = overview ? recentActivity(overview.environments) : [];

  return (
    <AppShell active="admin" githubConnected={Boolean(config?.githubConnected)} onSignOut={signOut}>
      <div className="admin-panel admin-in-shell">
      <section className="board-welcome">
        <div>
          <h1>Admin</h1>
          <p className="lede">Look after every preview by hand, and try out pull requests without going to GitHub.</p>
        </div>
      </section>

      <section className="panel" aria-label="Previews">
        <div className="ledger-head">
          <div>
            <h2>Previews</h2>
            <p className="help">Everything running now, plus any that failed to build. You&apos;ll always be asked before a preview is removed.</p>
          </div>
        </div>
        {loadError ? <p className="error" role="alert">{loadError}</p> : null}
        {!overview && !loadError ? <p className="empty">Loading previews…</p> : null}
        {overview && rows.length === 0 ? <p className="empty">Nothing is running right now.</p> : null}
        {rows.length > 0 ? (
          <ul className="preview-list">
            {rows.map((env) => {
              const demo = demoKey === `${env.repository}#${env.prNumber}`;
              const canSleep = env.status === "ready" && env.sleep === "awake";
              const canKeepAwake = env.status === "ready" || env.status === "updating";
              const awakeUntil =
                env.keepAwakeUntil && Date.parse(env.keepAwakeUntil) > now ? env.keepAwakeUntil : null;
              const pillState = cardState(env);
              const timeline = timelineNewestFirst(env.events);
              return (
                <li key={env.id} className={env.status === "ready" ? "env featured" : "env"}>
                  <div className="card-body">
                    <header className="admin-card-head">
                      <h3>
                        {demo ? "Demo preview" : `PR #${env.prNumber}`}
                        <span className="card-repo">{env.repository}</span>
                      </h3>
                      <span className="state-pill" data-state={pillState}>
                        {statePillLabel(pillState)}
                      </span>
                    </header>
                    {demo ? null : <p className="env-card-branch mono">{env.branch}</p>}
                    <p className="admin-card-note">
                      {stateNote(env)}
                      {awakeUntil ? ` Kept awake until ${formatAwakeUntil(awakeUntil)}.` : ""}
                    </p>
                    <Lifespan env={env} now={now} demo={demo} />
                    <p className="env-card-facts">
                      {demo ? null : (
                        <>
                          Commit <span className="mono">{env.sha.slice(0, 7)}</span>.{" "}
                        </>
                      )}
                      Last visited {formatAgo(env.lastActiveAt, now)}.
                      {typeof env.sleepSeconds === "number"
                        ? ` Falls asleep after ${env.sleepSeconds} s without visitors.`
                        : ""}
                    </p>
                    <details className="env-timeline">
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
                  </div>
                  <footer className="card-foot card-foot-admin">
                    {env.url ? (
                      <a className="open-preview" href={previewPath(env.url)}>
                        Open preview
                      </a>
                    ) : (
                      <button type="button" className="open-preview" disabled>
                        Open preview
                      </button>
                    )}
                    <div className="admin-actions">
                      <button type="button" className="secondary" disabled={busy || !canSleep} onClick={() => void sleepNow(env.id)}>
                        Put to sleep
                      </button>
                      <select
                        aria-label="Keep awake for"
                        value={keepAwakeHours}
                        disabled={busy || !canKeepAwake}
                        onChange={(event) => setKeepAwakeHours(Number(event.target.value) as 1 | 4 | 8)}
                      >
                        <option value={1}>1h</option>
                        <option value={4}>4h</option>
                        <option value={8}>8h</option>
                      </select>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !canKeepAwake}
                        onClick={() => void keepAwake(env, keepAwakeHours)}
                      >
                        Keep awake
                      </button>
                      {awakeUntil ? (
                        <button type="button" className="secondary" disabled={busy} onClick={() => void keepAwakeOff(env)}>
                          Stop keeping awake
                        </button>
                      ) : null}
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
                      <button type="button" className="secondary" disabled={busy || demo} onClick={() => void extend(env)}>
                        Extend
                      </button>
                      <button type="button" className="destroy" disabled={busy || env.status === "destroying"} onClick={() => void destroy(env)}>
                        Remove
                      </button>
                    </div>
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
          <summary>Try a pull request</summary>
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
                <p className="help">Leave empty for the usual lifetime. Enter 0 to make it run out straight away, then press Clean up now to see it removed.</p>
                <div className="actions">
                  <button type="submit" disabled={busy}>Open the pull request</button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void send("synchronize", { sha: "" })}
                  >
                    Push a new commit
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed")}>
                    Close it
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed", { merged: true })}>
                    Merge it
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void runReaper()}>
                    Clean up now
                  </button>
                </div>
              </form>
            </div>
          </article>
        </details>

        <section className="panel config-check" aria-label="Configuration check">
          <h2>Setup check</h2>
          <p className="help">
            Two settings worth checking: whether Mayfly can tell real GitHub messages from fake ones, and the address
            people use to open previews.
          </p>
          <dl className="settings config-check-list">
            <div>
              <dt>Messages from GitHub</dt>
              <dd>
                {config ? (
                  config.webhookVerification === "signed" ? (
                    <span className="config-status" data-tone="ok">
                      Verified
                    </span>
                  ) : (
                    <span className="config-status" data-tone="bad">
                      Not verified — anyone could pretend to be GitHub
                    </span>
                  )
                ) : (
                  "–"
                )}
              </dd>
            </div>
            <div>
              <dt>Public address</dt>
              <dd>
                {config ? (
                  <>
                    <span className="mono config-base-url">{config.previewBaseUrl}</span>
                    {isLocalPreviewBase(config.previewBaseUrl) ? (
                      <span className="config-status" data-tone="warn">
                        This is a local address, so links in PR comments won&apos;t work for anyone else
                      </span>
                    ) : null}
                  </>
                ) : (
                  "–"
                )}
              </dd>
            </div>
          </dl>
          {config ? (
            <p className="help">
              {config.onRender
                ? "To change these, set GITHUB_WEBHOOK_SECRET and PREVIEW_BASE_URL in Render → Environment."
                : "To change these, set GITHUB_WEBHOOK_SECRET and PREVIEW_BASE_URL in .env.local, then restart Mayfly."}
            </p>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-label="Recent activity">
        <h2>Recent activity</h2>
        {activity.length === 0 ? <p className="empty">No activity yet.</p> : null}
        <ol className="activity">
          {activity.map((item, index) => {
            const described = describeActivity(item.text);
            return (
              <li key={`${item.at}:${item.repository}:${item.prNumber}:${index}`} data-tone={described.tone}>
                <div className="activity-top">
                  <span className="activity-kind" data-tone={described.tone}>
                    {described.label}
                  </span>
                  <span className="activity-repo">
                    {item.repository} <span className="activity-pr">#{item.prNumber}</span>
                  </span>
                  <time className="activity-when" dateTime={item.at}>
                    {formatDelta(item.at, now)}
                  </time>
                </div>
                {described.detail ? <p className="activity-detail">{described.detail}</p> : null}
              </li>
            );
          })}
        </ol>
      </section>
      </div>
    </AppShell>
  );
}
