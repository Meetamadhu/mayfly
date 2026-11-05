"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;

function EnvironmentCard({
  env,
  copied,
  sleepSeconds,
  now,
  demo,
  buildsCode,
  onCopy,
}: {
  env: Environment;
  copied: boolean;
  sleepSeconds: number;
  now: number;
  demo: boolean;
  /** True when this Mayfly builds each pull request's own Dockerfile (Docker runtime), not the placeholder app. */
  buildsCode: boolean;
  onCopy: () => void;
}) {
  if (env.status === "destroyed") {
    const reason = env.destroyReason ?? "removed";
    return (
      <div className="removed-row" data-status="destroyed">
        <span className="chip removed-pill">Removed</span>
        <strong>
          {env.repository}
          <span> #{env.prNumber}</span>
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
  // A real pull request on a Docker Mayfly runs its own code; the demo and placeholder previews do not.
  const fromCode = buildsCode && !demo;
  const building = env.status === "provisioning" || env.status === "updating";
  const note =
    view.tone === "awake"
      ? `Sleeps in ${remain} s if nobody visits.`
      : fromCode && building
        ? "Building from the PR's Dockerfile…"
        : view.note;
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
          <span> #{env.prNumber}</span>
        </h3>
        <p className="meta">
          {demo ? null : <span className="chip">{env.branch}</span>}
          {demo ? null : <span className="chip mono">{env.sha.slice(0, 8)}</span>}
          {fromCode ? <span className="chip code-chip">Built from PR code</span> : null}
          <span className="chip">Last visit {formatDelta(env.lastActiveAt)}</span>
          {demo ? (
            <span className="chip">Always on</span>
          ) : (
            <span className="chip">Removed {formatDelta(env.expiresAt)}</span>
          )}
        </p>
        {path && env.url ? (
          <p className="url">
            <a href={path}>{path}</a>
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
            <a className="open-preview" href={path ?? undefined}>
              Open preview
            </a>
          )
        ) : (
          <span />
        )}
        {demo ? null : (
          <a
            className="gh-link"
            href={`https://github.com/${env.repository}/pull/${env.prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View PR on GitHub
          </a>
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

export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [polledAt, setPolledAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/environments", { cache: "no-store" });
    const body = (await response.json()) as Overview & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load environments.");
    setOverview(body);
    setLoadError(null);
    setPolledAt(Date.now());
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
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const config = overview?.config;
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  // The overview lists allowed repositories only when Mayfly builds pull request code, which is the Docker runtime.
  const dockerRuntime = config?.allowedRepositories != null;
  const liveCount = overview?.summary.live ?? 0;
  const capacity = config?.maxConcurrent ?? 0;
  const capacityRatio = capacity > 0 ? Math.min(1, liveCount / capacity) : 0;

  async function copyUrl(id: string, url: string) {
    try {
      const share = url.startsWith("/") ? `${window.location.origin}${url}` : url;
      await navigator.clipboard.writeText(share);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((currentId) => (currentId === id ? null : currentId)), 1500);
    } catch {
      setError("Could not copy the preview URL.");
    }
  }

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
      <AdminHeader />

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
      {polledAt != null ? (
        <p className="updated">Updated {Math.max(0, Math.floor((now - polledAt) / 1000))} s ago</p>
      ) : null}

      <div className="workspace">
        <section className="live-column">
          <div className="ledger-head">
            <div>
              <h2>Live</h2>
              <p className="help">Previews that are still running.</p>
            </div>
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
                copied={copiedId === env.id}
                sleepSeconds={config?.sleepSeconds ?? 20}
                now={now}
                demo={config?.demo === `${env.repository}#${env.prNumber}`}
                buildsCode={dockerRuntime}
                onCopy={() => void copyUrl(env.id, env.url ?? previewPath(""))}
              />
            ))}
          </div>

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
                      {deployment.port ? (
                        <span className="chip port-chip">port {deployment.port}</span>
                      ) : null}
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
          {showRemoved && removed.length > 0 ? (
            <div className="stack">
              {removed.length === 0 ? <p className="empty">No removed previews.</p> : null}
              {removed.map((env) => (
                <EnvironmentCard
                  key={env.id}
                  env={env}
                  copied={copiedId === env.id}
                  sleepSeconds={config?.sleepSeconds ?? 20}
                  now={now}
                  demo={config?.demo === `${env.repository}#${env.prNumber}`}
                  buildsCode={dockerRuntime}
                  onCopy={() => void copyUrl(env.id, env.url ?? previewPath(""))}
                />
              ))}
            </div>
          ) : null}
        </section>

        <div className="sim-column">
          <section className="panel try-it">
            <h2>Try it</h2>
            <ol>
              <li>Open a preview (the Demo, or a real PR if one is listed).</li>
              <li>You&apos;ll see &apos;Waking up&apos;, then the page.</li>
              <li>Come back: it shows Awake, then Asleep after {config?.sleepSeconds ?? 20} s.</li>
            </ol>
          </section>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </div>
      </div>

      <p className="footer">
        {config?.deployer === "fake"
          ? "This site keeps the record. The preview itself runs on the computer where Mayfly is running. "
          : ""}
        Each preview sleeps after {formatSleep(config?.sleepSeconds ?? 20)} without visitors and wakes on the next visit.
      </p>
    </main>
  );
}
