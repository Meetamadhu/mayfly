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
  canWrite,
  copied,
  sleepSeconds,
  now,
  demo,
  onCopy,
  onSleep,
  onDestroy,
}: {
  env: Environment;
  busy: boolean;
  canWrite: boolean;
  copied: boolean;
  sleepSeconds: number;
  now: number;
  demo: boolean;
  onCopy: () => void;
  onSleep: () => void;
  onDestroy: () => void;
}) {
  if (env.status === "destroyed") {
    const reason = env.destroyReason ?? "removed";
    return (
      <div className="removed-row" data-status="destroyed">
        <span className="chip removed-pill">Removed</span>
        <strong>
          {env.repository}
          <span>#{env.prNumber}</span>
        </strong>
        <span>
          {reason} · removed {formatDelta(env.destroyedAt ?? env.updatedAt)}
        </span>
      </div>
    );
  }

  const view = cardView(env);
  const path = env.url ? previewPath(env.url) : null;
  const remain = secondsUntilSleep(env, sleepSeconds, now);
  const note = view.tone === "awake" ? `Sleeps in ${remain} s if nobody visits.` : view.note;
  const showOpen = env.status !== "failed" && env.status !== "destroying";
  const openDisabled = env.status === "provisioning" || !env.url;
  return (
    <article className={env.status === "ready" ? "env featured" : "env"} data-status={env.status}>
      <header className="state-band" data-state={view.tone}>
        <div>
          <p className="state-word">
            <StateIcon name={view.icon} />
            {view.word}
          </p>
          <p className="explainer">{note}</p>
          {env.status === "ready" && env.sleep === "awake" ? (
            <div className="sleep-meter" aria-hidden="true">
              <span style={{ width: `${sleepSeconds > 0 ? (remain / sleepSeconds) * 100 : 0}%` }} />
            </div>
          ) : null}
        </div>
        {demo ? <span className="chip demo-chip">Demo</span> : null}
      </header>
      <div className="card-body">
        <h3>
          {env.repository}
          <span>#{env.prNumber}</span>
        </h3>
        <p className="meta">
          <span className="chip">{env.branch}</span>
          <span className="chip mono">{env.sha.slice(0, 8)}</span>
          <span className="chip">Last visit {formatDelta(env.lastActiveAt)}</span>
          {demo ? (
            <span className="chip">Always on</span>
          ) : (
            <span className="chip">Removed {formatDelta(env.expiresAt)}</span>
          )}
        </p>
        {path && env.url ? (
          <p className="url">
            <a href={env.url}>{path}</a>
            <button type="button" className="secondary" onClick={onCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
        ) : null}
        {env.status === "failed" && env.error ? <pre className="fail-box">{env.error}</pre> : null}
      </div>
      <footer className="card-foot">
        {showOpen ? (
          openDisabled ? (
            <button type="button" className="open-preview" disabled>
              Open preview
            </button>
          ) : (
            <a className="open-preview" href={env.url ?? undefined}>
              Open preview
            </a>
          )
        ) : (
          <span />
        )}
        {canWrite ? (
          <div className="row-actions">
            {env.status === "ready" && env.sleep === "awake" ? (
              <button type="button" className="secondary" disabled={busy} onClick={onSleep}>
                Sleep now
              </button>
            ) : null}
            {env.status !== "destroying" ? (
              <button type="button" className="destroy" disabled={busy} onClick={onDestroy}>
                Destroy
              </button>
            ) : null}
          </div>
        ) : (
          <p className="need-admin">Admin token needed to change this</p>
        )}
      </footer>
    </article>
  );
}

function cardView(env: Environment) {
  if (env.status === "provisioning" || env.status === "updating") {
    return {
      word: env.status === "updating" ? "Updating" : "Provisioning",
      tone: env.status,
      icon: "clock" as const,
      note: "Setting up the preview for this commit. The link works once it is ready.",
    };
  }
  if (env.status === "destroying") {
    return { word: "Destroying", tone: "destroying", icon: "clock" as const, note: "Removing this preview." };
  }
  if (env.status === "failed") {
    return {
      word: "Failed",
      tone: "failed",
      icon: "alert" as const,
      note: "The preview did not start. Destroy it, then push a new commit.",
    };
  }
  if (env.sleep === "asleep") {
    return { word: "Asleep", tone: "asleep", icon: "moon" as const, note: "App stopped. Wakes on the next visit." };
  }
  if (env.sleep === "waking") {
    return { word: "Waking", tone: "waking", icon: "clock" as const, note: "Starting up…" };
  }
  return { word: "Awake", tone: "awake", icon: "sun" as const, note: "" };
}

function secondsUntilSleep(env: Environment, sleepSeconds: number, now: number) {
  const elapsed = Math.floor((now - Date.parse(env.lastActiveAt)) / 1000);
  if (!Number.isFinite(elapsed)) return sleepSeconds;
  return Math.max(0, sleepSeconds - elapsed);
}

function StateIcon({ name }: { name: "moon" | "sun" | "clock" | "alert" }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  if (name === "moon") {
    return (
      <svg {...props}>
        <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
      </svg>
    );
  }
  if (name === "sun") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (name === "clock") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M12 3 2 21h20L12 3z" />
    </svg>
  );
}

function previewPath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function randomSha() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatDelta(iso: string) {
  const delta = Date.parse(iso) - Date.now();
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

function formatSleep(seconds: number) {
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

function formatLifetime(hours: number) {
  if (hours >= 48) {
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day" : `${days} days`;
  }
  return `${hours} h`;
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
  const [adminOpen, setAdminOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const canWrite = adminToken.length > 0;
  const anyAwake = overview?.environments.some((env) => env.status === "ready" && env.sleep === "awake") ?? false;

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
        const fast = body.environments.some(
          (env) => TRANSITIONAL.has(env.status) || (LIVE.has(env.status) && (env.sleep === "asleep" || env.sleep === "waking")),
        );
        if (fast) {
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

  useEffect(() => {
    if (!anyAwake) return;
    const update = () => setNow(Date.now());
    update();
    const tick = window.setInterval(update, 1000);
    return () => window.clearInterval(tick);
  }, [anyAwake]);

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

  async function act(id: string, action: "destroy" | "sleep") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/environments/${id}?action=${action}`, { method: "POST" });
      const body = (await readJson(response)) as { environment?: Environment };
      const env = body.environment;
      setFocusId(env?.id ?? null);
      setNotice(action === "sleep" ? "The preview app is asleep. The next visit wakes it." : null);
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
      ? focused.status === "ready" && focused.url && config?.deployer !== "fake"
        ? focused.url
        : focused.status === "ready" && config?.deployer === "fake"
          ? `${focused.repository}#${focused.prNumber} is recorded. Open the preview on the computer where Mayfly is running.`
          : `${focused.repository}#${focused.prNumber} is ${focused.status}${focused.destroyReason ? ` (${focused.destroyReason})` : ""}.`
      : null);

  return (
    <main className="shell">
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
      <header className="mast">
        <div className="mast-copy">
          <div className="mast-title">
            <h1>Mayfly</h1>
            <p className="subtitle">Ephemeral environments</p>
          </div>
          <p className="lede">
            Each pull request gets a preview. It sleeps when nobody&apos;s using it, wakes on the next visit, and is
            deleted when the PR closes or after its lifetime.
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
        <button
          type="button"
          className="admin-toggle"
          data-on={canWrite ? "true" : "false"}
          aria-pressed={adminOpen}
          onClick={() => setAdminOpen((open) => !open)}
        >
          {canWrite ? "Admin: on" : "Admin"}
        </button>
      </header>
      {adminOpen ? (
        <section className="panel admin" aria-label="Admin access">
          {canWrite ? (
            <div className="admin-row">
              <p className="help">This tab can change previews.</p>
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
            </form>
          )}
        </section>
      ) : null}

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
          <dt>Sleeps after</dt>
          <dd>{config ? formatSleep(config.sleepSeconds) : "–"}</dd>
        </div>
        <div>
          <dt>Max lifetime</dt>
          <dd>{config ? formatLifetime(config.ttlHours) : "–"}</dd>
        </div>
      </dl>

      <div className="workspace">
        <section className="live-column">
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
                busy={busy}
                canWrite={canWrite}
                copied={copiedId === env.id}
                sleepSeconds={config?.sleepSeconds ?? 20}
                now={now}
                demo={config?.demo === `${env.repository}#${env.prNumber}`}
                onCopy={() => void copyUrl(env.id, env.url ?? "")}
                onSleep={() => void act(env.id, "sleep")}
                onDestroy={() => void act(env.id, "destroy")}
              />
            ))}
          </div>

          <details className="advanced">
            <summary>Advanced: processes</summary>
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
                {config?.deployer === "fake" ? null : (
                  <a className="open-link" href={deployment.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                )}
              </article>
            ))}
          </div>
          </details>

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
                  busy={busy}
                  canWrite={canWrite}
                  copied={copiedId === env.id}
                  sleepSeconds={config?.sleepSeconds ?? 20}
                  now={now}
                  demo={config?.demo === `${env.repository}#${env.prNumber}`}
                  onCopy={() => void copyUrl(env.id, env.url ?? "")}
                  onSleep={() => void act(env.id, "sleep")}
                  onDestroy={() => void act(env.id, "destroy")}
                />
              ))}
            </div>
          ) : null}
        </section>

        <div className="sim-column">
          {!canWrite ? <p className="readonly">Read-only. Changes need the admin token.</p> : null}
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
              <button type="submit" disabled={busy || !canWrite}>Open PR</button>
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
                Close PR
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !canWrite}
                onClick={() => void send("closed", { merged: true })}
              >
                Merge PR
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
      </div>

      <p className="footer">
        {config?.deployer === "fake"
          ? "This site keeps the record. The preview itself runs on the computer where Mayfly is running."
          : `Each preview listens on its own port, sleeps after ${config?.sleepSeconds ?? 20}s without a request, and wakes on the next visit.`}{" "}
        The reaper runs every {config ? Math.round(config.reaperIntervalMs / 1000) : 60}s. Changes need the admin token; without it the board is read-only.
      </p>
    </main>
  );
}
