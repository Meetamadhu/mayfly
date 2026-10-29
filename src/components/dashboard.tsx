"use client";

import { useCallback, useEffect, useState } from "react";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;

function EnvironmentCard({
  env,
  busy,
  copied,
  onCopy,
  onIdle,
  onDestroy,
}: {
  env: Environment;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onIdle: () => void;
  onDestroy: () => void;
}) {
  const actionable = env.status === "ready" || env.status === "updating" || env.status === "provisioning";
  return (
    <article className={env.status === "ready" ? "env featured" : "env"} data-status={env.status}>
      <header>
        <div>
          <h3>
            {env.repository}
            <span>#{env.prNumber}</span>
          </h3>
          <p className="meta">
            <span className="chip mono">{env.sha.slice(0, 12)}</span>
            <span className="chip">{env.branch}</span>
            <span className="chip">active {formatDelta(env.lastActiveAt)}</span>
            <span className="chip">
              {env.status === "destroyed"
                ? `removed ${formatDelta(env.destroyedAt ?? env.updatedAt)}`
                : `expires ${formatDelta(env.expiresAt)}`}
            </span>
            {env.destroyReason ? <span className="chip">reason {env.destroyReason}</span> : null}
          </p>
        </div>
        <div className="badges">
          {isLive(env.status) && env.sleep && env.sleep !== "unknown" ? (
            <span className="sleep" data-sleep={env.sleep}>
              {env.sleep === "awake" ? "Awake" : "Asleep"}
            </span>
          ) : null}
          <span className="status" data-status={env.status}>
            {env.status}
          </span>
        </div>
      </header>
      {env.url ? (
        <p className="url">
          <a href={env.url} target="_blank" rel="noreferrer">
            {env.url}
          </a>
        </p>
      ) : null}
      {env.error ? <p className="error">{env.error}</p> : null}
      {env.comments.at(-1) ? <p className="comment">{env.comments.at(-1)?.body.split("\n")[0]}</p> : null}
      {actionable ? (
        <div className="row-actions">
          {env.url ? (
            <a className="open-link" href={env.url} target="_blank" rel="noreferrer">
              Open preview
            </a>
          ) : null}
          {env.status === "ready" ? (
            <button type="button" className="secondary" disabled={busy} onClick={onIdle}>
              Mark idle
            </button>
          ) : null}
          <button type="button" className="secondary" disabled={busy} onClick={onDestroy}>
            Destroy
          </button>
          {env.url ? (
            <button type="button" className="secondary" onClick={onCopy}>
              {copied ? "Copied" : "Copy URL"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function isLive(status: EnvironmentStatus) {
  return LIVE.has(status);
}

function randomSha() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatDelta(iso: string) {
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) return iso;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return delta >= 0 ? "now" : "just now";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const text = hours > 0 ? `${hours}h ${rest}m` : `${minutes}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

// The admin token lives only in this browser tab. It is never rendered into the page or sent anywhere but Mayfly's own API.
const TOKEN_KEY = "mayfly-admin-token";

function readStoredToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token: string) {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token still works until the page reloads.
  }
}

async function readJson(response: Response) {
  const body = (await response.json()) as { error?: string; ok?: boolean };
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState("acme/web");
  const [prNumber, setPrNumber] = useState("42");
  const [branch, setBranch] = useState("feat/preview-lifetime");
  const [sha, setSha] = useState("a1b2c3d4e5f67890");
  const [ttlMinutes, setTtlMinutes] = useState("480");
  const [showRemoved, setShowRemoved] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const canWrite = adminToken.length > 0;

  useEffect(() => {
    setAdminToken(readStoredToken());
  }, []);

  function applyToken() {
    const token = tokenDraft.trim();
    if (!token) return;
    storeToken(token);
    setAdminToken(token);
    setTokenDraft("");
    setError(null);
  }

  function forgetToken() {
    storeToken("");
    setAdminToken("");
  }

  /** Every write goes through here so it carries the token, and a rejected token turns the board read-only again. */
  async function adminFetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${adminToken}`);
    const response = await fetch(url, { ...init, headers });
    if (response.status === 401) {
      forgetToken();
      throw new Error("The admin token was not accepted. Enter it again.");
    }
    return response;
  }

  const reload = useCallback(async () => {
    const response = await fetch("/api/environments", { cache: "no-store" });
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
        if (body.environments.some((env) => TRANSITIONAL.has(env.status))) {
          timer = window.setTimeout(() => void tick(), FAST_POLL_MS);
        } else if (body.environments.some((env) => LIVE.has(env.status))) {
          timer = window.setTimeout(() => void tick(), LIVE_POLL_MS);
        }
      } catch (caught) {
        if (!cancelled) {
          setLoadError(caught instanceof Error ? caught.message : "Could not load environments.");
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reload, overview?.summary.live, overview?.environments.map((env) => `${env.id}:${env.status}`).join("|")]);

  async function send(
    action: "opened" | "synchronize" | "closed" | "reopened",
    overrides?: { sha?: string; merged?: boolean },
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          repository,
          prNumber: Number(prNumber),
          sha: overrides?.sha ?? sha,
          branch,
          merged: overrides?.merged ?? false,
          ttlMinutes: Number(ttlMinutes),
        }),
      });
      const body = (await readJson(response)) as { environment?: Environment; action?: string };
      setNotice(null);
      setFocusId(body.environment?.id ?? null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "destroy" | "idle") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/environments/${id}?action=${action}`, { method: "POST" });
      const body = (await readJson(response)) as { environment?: Environment };
      const env = body.environment;
      setFocusId(env?.id ?? null);
      setNotice(action === "idle" ? "Marked idle. Run the reaper to delete it." : null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runReaper() {
    const started = Date.now();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFocusId(null);
    try {
      const response = await adminFetch("/api/reaper", { method: "POST" });
      const body = (await readJson(response)) as { destroyed: Environment[]; failed: { error: string }[] };
      const fresh = await reload();
      const recent = fresh.environments.filter(
        (env) => env.destroyedAt && Date.parse(env.destroyedAt) >= started - 2_000,
      );
      if (body.failed.length > 0) {
        setError(body.failed.map((item) => item.error).join(" "));
      } else if (body.destroyed.length > 0) {
        const reasons = body.destroyed.map((env) => `${env.repository}#${env.prNumber} (${env.destroyReason})`).join(", ");
        setNotice(`Destroyed ${body.destroyed.length}: ${reasons}.`);
      } else if (recent.length > 0) {
        const reasons = recent.map((env) => `${env.repository}#${env.prNumber} (${env.destroyReason})`).join(", ");
        setNotice(`Destroyed ${recent.length}: ${reasons}.`);
      } else {
        setNotice("Nothing was due. Live previews are still inside their TTL and idle window.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reaper failed.");
    } finally {
      setBusy(false);
    }
  }

  const config = overview?.config;
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  const liveCount = overview?.summary.live ?? 0;
  const capacity = config?.maxConcurrent ?? 0;
  const capacityRatio = capacity > 0 ? Math.min(1, liveCount / capacity) : 0;
  const focused = overview?.environments.find((env) => env.id === focusId) ?? null;

  async function copyUrl(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((currentId) => (currentId === id ? null : currentId)), 1500);
    } catch {
      setError("Could not copy the preview URL.");
    }
  }
  const statusLine =
    notice ??
    (focused
      ? focused.status === "ready" && focused.url
        ? focused.url
        : `${focused.repository}#${focused.prNumber} is ${focused.status}${focused.destroyReason ? ` (${focused.destroyReason})` : ""}.`
      : null);

  return (
    <main className="shell">
      <header className="mast">
        <div className="mast-copy">
          <div className="mast-title">
            <h1>Mayfly</h1>
            <p className="subtitle">Ephemeral environments</p>
          </div>
          <p className="lede">
            A pull request gets a test deployment. Close it, leave it idle, or let the clock run out, and the
            deployment is deleted so staging stops billing.
          </p>
        </div>
        {config ? (
          <div className="pills">
            <span className="pill">
              {config.webhookVerification === "signed" ? "Signatures required" : "Signatures open"}
            </span>
            <span className="pill">
              {config.deployer === "fake" ? "Recorded previews" : `Sleeps after ${config.sleepSeconds}s`}
            </span>
          </div>
        ) : null}
      </header>

      <dl className="stats">
        <div>
          <dt>Live</dt>
          <dd>
            {overview ? liveCount : "–"}
            <span>/{capacity || "–"}</span>
          </dd>
          <div className="meter" aria-hidden="true">
            <span data-hot={capacityRatio >= 0.8 ? "true" : "false"} style={{ width: `${capacityRatio * 100}%` }} />
          </div>
        </div>
        <div>
          <dt>Awake</dt>
          <dd>{overview?.summary.awake ?? "–"}</dd>
        </div>
        <div>
          <dt>Asleep</dt>
          <dd>{overview?.summary.asleep ?? "–"}</dd>
        </div>
        <div>
          <dt>Removed</dt>
          <dd>{overview?.summary.destroyed ?? "–"}</dd>
        </div>
        <div>
          <dt>Idle window</dt>
          <dd>
            {config?.idleHours ?? "–"}
            <span>h</span>
          </dd>
        </div>
        <div>
          <dt>Max lifetime</dt>
          <dd>
            {config?.ttlHours ?? "–"}
            <span>h</span>
          </dd>
        </div>
      </dl>

      <section className="panel admin" aria-label="Admin access">
        {canWrite ? (
          <div className="admin-row">
            <p className="help">Admin token set for this tab. Open, Merge, Destroy and Run reaper are enabled.</p>
            <button type="button" className="secondary" onClick={forgetToken}>
              Forget token
            </button>
          </div>
        ) : (
          <form
            className="admin-row"
            onSubmit={(event) => {
              event.preventDefault();
              applyToken();
            }}
          >
            <label>
              Admin token
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!tokenDraft.trim()}>
              Use token
            </button>
            <p className="help">Read-only until you enter the server's MAYFLY_ADMIN_TOKEN. It is kept in this tab only.</p>
          </form>
        )}
      </section>

      <div className="board">
        <section>
          <div className="ledger-head">
            <div>
              <h2>Live</h2>
              <p className="help">Previews that are still running.</p>
            </div>
            <button type="button" className="secondary" disabled={busy || !canWrite} onClick={() => void runReaper()}>
              Run reaper
            </button>
          </div>

          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="empty">Loading the ledger…</p> : null}

          <div className="stack">
            {overview && current.length === 0 ? (
              <p className="empty">No live previews. Open a pull request and it will show up here.</p>
            ) : null}
            {current.map((env) => (
              <EnvironmentCard
                key={env.id}
                env={env}
                busy={busy || !canWrite}
                copied={copiedId === env.id}
                onCopy={() => void copyUrl(env.id, env.url ?? "")}
                onIdle={() => void act(env.id, "idle")}
                onDestroy={() => void act(env.id, "destroy")}
              />
            ))}
          </div>

          <div className="ledger-head running-head">
            <div>
              <h2>Ports</h2>
              <p className="help">Processes still listening.</p>
            </div>
          </div>
          <div className="stack">
            {overview && overview.deployments.length === 0 ? (
              <p className="empty">Nothing is listening. Closed, idle, and expired previews are gone.</p>
            ) : null}
            {overview?.deployments.map((deployment) => (
              <article className="deployment" key={deployment.deploymentId}>
                <div>
                  <strong>
                    {deployment.repository}
                    <span>#{deployment.prNumber}</span>
                  </strong>
                  <p className="meta">
                    <span className="chip mono">{deployment.sha.slice(0, 12)}</span>
                    {deployment.port ? <span className="chip">port {deployment.port}</span> : null}
                  </p>
                </div>
                <a className="open-link" href={deployment.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              </article>
            ))}
          </div>

          {overview ? (
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
          {showRemoved ? (
            <div className="stack">
              {removed.length === 0 ? <p className="empty">No removed previews.</p> : null}
              {removed.map((env) => (
                <EnvironmentCard
                  key={env.id}
                  env={env}
                  busy={busy || !canWrite}
                  copied={copiedId === env.id}
                  onCopy={() => void copyUrl(env.id, env.url ?? "")}
                  onIdle={() => void act(env.id, "idle")}
                  onDestroy={() => void act(env.id, "destroy")}
                />
              ))}
            </div>
          ) : null}
        </section>

        <details className="panel simulator">
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
              <input value={repository} onChange={(event) => setRepository(event.target.value)} required />
            </label>
            <label>
              Pull request
              <input
                value={prNumber}
                onChange={(event) => setPrNumber(event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              Branch
              <input value={branch} onChange={(event) => setBranch(event.target.value)} required />
            </label>
            <label>
              Commit
              <input value={sha} onChange={(event) => setSha(event.target.value)} className="mono" required />
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
              <button type="submit" disabled={busy || !canWrite}>Open</button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !canWrite}
                onClick={() => {
                  const next = randomSha();
                  setSha(next);
                  void send("synchronize", { sha: next });
                }}
              >
                Push commit
              </button>
              <button type="button" className="secondary" disabled={busy || !canWrite} onClick={() => void send("closed")}>
                Close
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !canWrite}
                onClick={() => void send("closed", { merged: true })}
              >
                Merge
              </button>
            </div>
          </form>
          {statusLine ? (
            <p className="notice" role="status">
              {statusLine.startsWith("http") ? (
                <a href={statusLine} target="_blank" rel="noreferrer">{statusLine}</a>
              ) : (
                statusLine
              )}
            </p>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
        </details>
      </div>

      <p className="footer">
        {config?.deployer === "fake"
          ? "Destroy removes the preview record."
          : `Each preview listens on its own port, sleeps after ${config?.sleepSeconds ?? 20}s without a request, and wakes on the next visit.`}{" "}
        The reaper runs every {config ? Math.round(config.reaperIntervalMs / 1000) : 60}s. Changes need the admin token; without it the board is read-only.
      </p>
    </main>
  );
}
