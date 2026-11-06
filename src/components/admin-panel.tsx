"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;

// Hints and starting values for the simulator form: the sample app's pull request. The commit starts empty, which
// means the pull request's latest commit, so a stale default can never roll a live preview back.
const SAMPLE = {
  repository: "meetamadhu/mayfly-sample-app",
  prNumber: "1",
  branch: "feature/new-heading",
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

function stateWord(env: Environment) {
  if (env.status === "provisioning") return "Provisioning";
  if (env.status === "updating") return "Updating";
  if (env.status === "destroying") return "Destroying";
  if (env.status === "failed") return "Failed";
  if (env.sleep === "asleep") return "Asleep";
  if (env.sleep === "waking") return "Waking";
  return "Awake";
}

function stateTone(env: Environment) {
  if (env.status !== "ready") return env.status;
  if (env.sleep === "asleep" || env.sleep === "waking") return env.sleep;
  return "awake";
}

function webhookMode(mode: Overview["config"]["webhookVerification"]) {
  return mode === "signed" ? "Signed" : "Open in development";
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
      const reason = env.destroyReason ? `Removed (${env.destroyReason})` : "Removed";
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
  const [ttlMinutes, setTtlMinutes] = useState("480");
  const [extendHours, setExtendHours] = useState("4");
  const [now, setNow] = useState(() => Date.now());

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
      throw new Error("Sign in again.");
    }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
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
      const response = await fetch("/api/events", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          repository,
          prNumber: Number(prNumber),
          sha: overrides?.sha ?? sha,
          branch,
          merged: overrides?.merged ?? false,
          ttlMinutes: Number(ttlMinutes),
          wait: true,
        }),
      });
      await readBody(response);
      setNotice(action === "opened" ? "Preview opened." : null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
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
      setError(caught instanceof Error ? caught.message : "Request failed.");
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
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy(env: Environment) {
    if (!window.confirm(`Destroy ${env.repository} #${env.prNumber}?`)) return;
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
      setError(caught instanceof Error ? caught.message : "Request failed.");
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
      else if (body.destroyed.length > 0) setNotice(`Destroyed ${body.destroyed.length}.`);
      else setNotice("Nothing was due.");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reaper failed.");
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
    <main className="shell admin-panel">
      <AdminHeader onSignOut={() => void signOut()} />

      <section className="panel" aria-label="Previews">
        <div className="ledger-head">
          <div>
            <h2>Previews</h2>
            <p className="help">Live previews. Destroy asks before it removes one.</p>
          </div>
        </div>
        {loadError ? <p className="error" role="alert">{loadError}</p> : null}
        {!overview && !loadError ? <p className="empty">Loading the ledger…</p> : null}
        {overview && rows.length === 0 ? <p className="empty">No live previews.</p> : null}
        {rows.length > 0 ? (
          <ul className="preview-list">
            {rows.map((env) => {
              const demo = demoKey === `${env.repository}#${env.prNumber}`;
              const canSleep = env.status === "ready" && env.sleep === "awake";
              const tone = stateTone(env);
              return (
                <li key={env.id} data-tone={tone}>
                  <div className="preview-top">
                    <span className="state-pill" data-state={tone}>
                      {stateWord(env)}
                    </span>
                    <span className="activity-repo">
                      {env.repository} <span className="activity-pr">#{env.prNumber}</span>
                    </span>
                  </div>
                  <dl className="preview-meta">
                    <div>
                      <dt>Branch</dt>
                      <dd>{env.branch}</dd>
                    </div>
                    <div>
                      <dt>Last visit</dt>
                      <dd>{formatDelta(env.lastActiveAt, now)}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{demo ? "Always on" : formatDelta(env.expiresAt, now)}</dd>
                    </div>
                  </dl>
                  <div className="row-actions">
                    {env.url ? (
                      <a className="open-preview" href={previewPath(env.url)}>
                        Open
                      </a>
                    ) : (
                      <button type="button" className="open-preview" disabled>
                        Open
                      </button>
                    )}
                    <button type="button" className="secondary" disabled={busy || !canSleep} onClick={() => void sleepNow(env.id)}>
                      Sleep now
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
                    <button type="button" className="secondary" disabled={busy || demo} onClick={() => void extend(env)}>
                      Extend
                    </button>
                    <button type="button" className="destroy" disabled={busy || env.status === "destroying"} onClick={() => void destroy(env)}>
                      Destroy
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
      </section>

      <div className="workspace">
        <details className="panel simulator" open>
          <summary>Simulate a pull request</summary>
          <p className="help">
            This talks to Mayfly directly. GitHub can send the same actions to <span className="mono">/api/webhooks/github</span>.
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
                onChange={(event) => setPrNumber(event.target.value)}
                placeholder={SAMPLE.prNumber}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              Branch
              <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={SAMPLE.branch} required />
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
              TTL minutes
              <input
                value={ttlMinutes}
                onChange={(event) => setTtlMinutes(event.target.value)}
                inputMode="numeric"
                min={0}
                max={10080}
                required
              />
            </label>
            <p className="help">Use 0 to expire as soon as the preview is ready, then run the reaper.</p>
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
                Close PR
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed", { merged: true })}>
                Merge PR
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void runReaper()}>
                Run reaper
              </button>
            </div>
          </form>
        </details>

        <section className="panel" aria-label="Settings">
          <h2>Settings</h2>
          <dl className="settings">
            <div>
              <dt>Sleep seconds</dt>
              <dd>{config ? config.sleepSeconds : "–"}</dd>
            </div>
            <div>
              <dt>Lifetime</dt>
              <dd>{config ? formatLifetime(config.ttlHours) : "–"}</dd>
            </div>
            <div>
              <dt>Max previews</dt>
              <dd>{config ? config.maxConcurrent : "–"}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd className="mono">{config?.previewBaseUrl ?? "–"}</dd>
            </div>
            <div>
              <dt>Webhook mode</dt>
              <dd>{config ? webhookMode(config.webhookVerification) : "–"}</dd>
            </div>
          </dl>
          {config ? (
            <p className="help">{config.onRender ? "Change these in Render → Environment" : "Change these in .env.local"}</p>
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
    </main>
  );
}
