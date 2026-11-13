"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import type { Environment, EnvironmentStatus, Overview, UsageDay, UsageMonth } from "@/lib/types";

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
  costPerHour,
  onCopy,
}: {
  env: Environment;
  copied: boolean;
  sleepSeconds: number;
  now: number;
  demo: boolean;
  /** True when this Mayfly builds each pull request's own Dockerfile (Docker runtime), not the placeholder app. */
  buildsCode: boolean;
  costPerHour: number;
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
  const idleSeconds = typeof env.sleepSeconds === "number" ? env.sleepSeconds : sleepSeconds;
  const remain = secondsUntilSleep(env, idleSeconds, now);
  const awakeUntil =
    env.keepAwakeUntil && Date.parse(env.keepAwakeUntil) > now ? env.keepAwakeUntil : null;
  // A real pull request on a Docker Mayfly runs its own code; the demo and placeholder previews do not.
  const fromCode = buildsCode && !demo;
  const building = env.status === "provisioning" || env.status === "updating";
  const note =
    view.tone === "awake" && awakeUntil
      ? `Kept awake until ${formatAwakeUntil(awakeUntil)}.`
      : view.tone === "awake"
        ? `Sleeps in ${remain} s if nobody visits.`
        : fromCode && building
          ? "Building from the PR's Dockerfile…"
          : view.note;
  const showOpen = env.status !== "failed" && env.status !== "destroying";
  const openDisabled = env.status === "provisioning" || !env.url;
  const expiresValue = demo ? "Always on" : formatExpiresValue(env.expiresAt, now);

  return (
    <article className={env.status === "ready" ? "env featured" : "env"} data-status={env.status}>
      <header className="state-band" data-state={view.tone}>
        <div>
          <p className="state-word">
            <StateIcon name={view.icon} />
            {view.word}
          </p>
          <p className="explainer">{note}</p>
          {env.status === "ready" && env.sleep === "awake" && !awakeUntil ? (
            <div className="sleep-meter" aria-hidden="true">
              <span style={{ width: `${idleSeconds > 0 ? (remain / idleSeconds) * 100 : 0}%` }} />
            </div>
          ) : null}
        </div>
        {demo ? <span className="chip demo-chip">Demo</span> : null}
        {awakeUntil ? <span className="chip">Awake until {formatAwakeUntil(awakeUntil)}</span> : null}
      </header>
      <div className="card-body">
        <p className="card-repo">{env.repository}</p>
        <h3>{demo ? <>#{env.prNumber} · demo</> : <>#{env.prNumber}</>}</h3>
        <p className="meta meta-facts">
          {demo ? null : (
            <span className="fact-pill" data-fact="branch">
              <span className="fact-label">Branch</span>
              <span className="fact-value mono">{env.branch}</span>
            </span>
          )}
          <span className="fact-pill" data-fact="visit">
            <span className="fact-label">Last visit</span>
            <span className="fact-value">{formatAgo(env.lastActiveAt, now)}</span>
          </span>
          <span className="fact-pill" data-fact="expires">
            <span className="fact-label">Expires</span>
            <span className="fact-value">{expiresValue}</span>
          </span>
        </p>
        <p className="meta">
          {demo ? null : <span className="chip mono">{env.sha.slice(0, 8)}</span>}
          <span className="chip">Sleeps after {idleSeconds} s</span>
          {fromCode ? <span className="chip code-chip">Built from PR code</span> : null}
          {typeof env.buildMs === "number" && env.buildMs >= 0 ? (
            <span className="chip timing-chip">Built in {formatDurationMs(env.buildMs)}</span>
          ) : null}
          {typeof env.lastWakeMs === "number" && env.lastWakeMs >= 0 ? (
            <span className="chip timing-chip">Last wake {formatDurationMs(env.lastWakeMs)}</span>
          ) : null}
        </p>
        {path && env.url ? (
          <p className="url">
            <a href={previewHref(env.url)}>{path}</a>
            <button type="button" className="copy-icon" onClick={onCopy} aria-label={copied ? "Copied" : "Copy link"} title={copied ? "Copied" : "Copy link"}>
              {copied ? <CheckIcon /> : <ClipboardIcon />}
            </button>
          </p>
        ) : (
          <p className="url url-empty" aria-hidden="true" />
        )}
        {env.status === "failed" && env.error ? <pre className="fail-box">{env.error}</pre> : null}
        <p className="card-usage">{formatPreviewUsage(env, costPerHour, demo)}</p>
      </div>
      <footer className="card-foot">
        {showOpen ? (
          openDisabled ? (
            <button type="button" className="open-preview" disabled>
              Open preview
            </button>
          ) : (
            <a className="open-preview" href={previewHref(env.url)}>
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

function formatAwakeUntil(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

function ClipboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
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

/** Sandboxed previews cannot read localStorage; pass the board theme in the URL. */
function previewHref(url: string | null | undefined) {
  if (!url) return undefined;
  const path = previewPath(url);
  try {
    const theme =
      typeof document !== "undefined" &&
      (document.documentElement.dataset.theme === "dark" || document.documentElement.dataset.theme === "light")
        ? document.documentElement.dataset.theme
        : null;
    if (!theme) return path;
    const next = new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    next.searchParams.set("mayfly_theme", theme);
    return `${next.pathname}${next.search}`;
  } catch {
    return path;
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

function formatAgo(iso: string, now: number) {
  const delta = now - Date.parse(iso);
  if (Number.isNaN(delta)) return iso;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return "just now";
  const hours = Math.floor(Math.abs(delta) / 3600000);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
  if (hours > 0) return `${hours} h ${rest} m ago`;
  return `${minutes} m ago`;
}

function formatExpiresValue(iso: string, now: number) {
  const delta = Date.parse(iso) - now;
  if (Number.isNaN(delta)) return iso;
  if (delta <= 0) return "Expired";
  const totalMin = Math.floor(delta / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `in ${days} d ${hours % 24} h`;
  }
  if (hours > 0) return `in ${hours} h ${mins} m`;
  return `in ${Math.max(1, mins)} m`;
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

function formatMoney(amount: number) {
  return amount.toFixed(2);
}

function formatSaved(amount: number) {
  if (amount < 0.01) return "< $0.01";
  return `≈ $${amount.toFixed(2)}`;
}

function formatContainerHours(seconds: number) {
  const hours = seconds / 3600;
  if (hours >= 10) return hours.toFixed(1);
  return hours.toFixed(2);
}

/** Card durations: "< 1 min", "4 min", or "1.2 h". */
function formatUsageDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 60) return "< 1 min";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  const hours = seconds / 3600;
  if (hours < 10) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours)} h`;
}

function estimatedCost(seconds: number, costPerHour: number) {
  return (seconds / 3600) * costPerHour;
}

function formatEstMoney(amount: number) {
  if (!Number.isFinite(amount) || amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

function formatPreviewUsage(env: Environment, costPerHour: number, demo: boolean) {
  if (demo) return "—";
  if (!env.usage) return "—";
  const awake = env.usage.awakeSeconds ?? 0;
  const asleep = env.usage.asleepSeconds ?? 0;
  const saved = estimatedCost(asleep, costPerHour);
  return `Awake ${formatUsageDuration(awake)} · Asleep ${formatUsageDuration(asleep)} · Est. saved ${formatEstMoney(saved)}`;
}

function last14DayKeys(now = Date.now()) {
  const keys: string[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    keys.push(new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return keys;
}

function dayTotals(days: Record<string, UsageDay> | undefined, key: string): UsageDay {
  const day = days?.[key];
  return {
    awakeSeconds: day?.awakeSeconds ?? 0,
    asleepSeconds: day?.asleepSeconds ?? 0,
  };
}

function formatDayParts(isoDay: string) {
  const ms = Date.parse(`${isoDay}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return { day: isoDay, month: "" };
  const date = new Date(ms);
  return {
    day: date.toLocaleDateString("en-GB", { day: "numeric", timeZone: "UTC" }),
    month: date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
  };
}

function CostDayChart({
  usage,
  costPerHour,
}: {
  usage: UsageMonth | undefined;
  costPerHour: number;
}) {
  const keys = last14DayKeys();
  const points = keys.map((key) => {
    const day = dayTotals(usage?.days, key);
    const always = estimatedCost(day.awakeSeconds + day.asleepSeconds, costPerHour);
    const actual = estimatedCost(day.awakeSeconds, costPerHour);
    return { key, always, actual, ...formatDayParts(key) };
  });
  const maxValue = Math.max(0, ...points.map((p) => p.always));
  const scaleMax = maxValue > 0 ? maxValue : 0.01;
  const maxLabel = maxValue <= 0 ? "$0.00" : formatEstMoney(maxValue);

  return (
    <figure className="cost-chart" aria-label="Estimated daily cost, last 14 days">
      <div className="cost-chart-plot">
        <div className="cost-chart-axis" aria-hidden="true">
          <span className="cost-chart-max">{maxLabel}</span>
          <span className="cost-chart-axis-line" />
        </div>
        <div className="cost-chart-bars" role="img" aria-hidden="true">
          {points.map((point, index) => {
            const alwaysPct = Math.min(100, (point.always / scaleMax) * 100);
            const actualPct = Math.min(100, (point.actual / scaleMax) * 100);
            const showLabel = index % 2 === 0 || index === points.length - 1;
            return (
              <div key={point.key} className="cost-day" data-label={showLabel ? "show" : "hide"}>
                <div className="cost-day-bars">
                  <span
                    className="cost-bar cost-bar-always"
                    style={{ height: point.always > 0 ? `${Math.max(alwaysPct, 3)}%` : "0%" }}
                  />
                  <span
                    className="cost-bar cost-bar-actual"
                    style={{ height: point.actual > 0 ? `${Math.max(actualPct, 3)}%` : "0%" }}
                  />
                </div>
                <span className="cost-day-label">
                  <span className="cost-day-dom">{point.day}</span>
                  <span className="cost-day-mon">{point.month}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="cost-chart-legend">
        <span>
          <i className="cost-swatch cost-swatch-always" aria-hidden="true" /> If always awake
        </span>
        <span>
          <i className="cost-swatch cost-swatch-actual" aria-hidden="true" /> Estimated actual
        </span>
      </figcaption>
    </figure>
  );
}

function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs ? `${mins} min ${secs} s` : `${mins} min`;
}

type BoardFilter = "all" | "awake" | "asleep" | "expiring";

const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

function matchesBoardFilter(env: Environment, filter: BoardFilter, now: number, demoKey: string | null) {
  if (filter === "all") return true;
  if (filter === "awake") return env.sleep === "awake" || env.sleep === "waking";
  if (filter === "asleep") return env.sleep === "asleep";
  if (filter === "expiring") {
    if (demoKey && demoKey === `${env.repository}#${env.prNumber}`) return false;
    if (!env.expiresAt) return false;
    const left = Date.parse(env.expiresAt) - now;
    return Number.isFinite(left) && left > 0 && left <= EXPIRING_SOON_MS;
  }
  return true;
}

function matchesBoardSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber).includes(q) ||
    env.sha.toLowerCase().includes(q)
  );
}

export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [boardQuery, setBoardQuery] = useState("");

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
  const demoKey = config?.demo ?? null;
  const visible = current.filter(
    (env) => matchesBoardFilter(env, boardFilter, now, demoKey) && matchesBoardSearch(env, boardQuery),
  );
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

      <section className="savings-hero" aria-label="Estimated savings this month">
        <p className="savings-figure">
          {overview ? (
            <>
              {formatSaved(overview.savedEstimate)}
              <span> estimated saved this month</span>
            </>
          ) : (
            "–"
          )}
        </p>
        <p className="savings-sub">
          {overview
            ? `Awake ${formatContainerHours(overview.usage?.awakeSeconds ?? 0)} h · Asleep ${formatContainerHours(overview.usage?.asleepSeconds ?? 0)} h · at $${formatMoney(overview.costPerHour ?? 0.05)}/h estimated`
            : "Waiting for the first reaper sample…"}
        </p>
        {overview ? (
          <CostDayChart usage={overview.usage} costPerHour={overview.costPerHour ?? 0.05} />
        ) : null}
      </section>

      <p className="board-settings">
        {config
          ? `Sleeps after ${formatSleep(config.sleepSeconds)} · Max lifetime ${formatLifetime(config.ttlHours)}`
          : "Sleeps after – · Max lifetime –"}
      </p>

      <dl className="stats">
        <div data-stat="live">
          <dt>Live</dt>
          <dd>
            {overview ? liveCount : "–"}
            <span>/{capacity || "–"}</span>
          </dd>
          <div className="meter" aria-hidden="true">
            <span data-hot={capacityRatio >= 0.8 ? "true" : "false"} style={{ width: `${capacityRatio * 100}%` }} />
          </div>
        </div>
        <div data-stat="awake">
          <dt>Awake</dt>
          <dd>{overview?.summary.awake ?? "–"}</dd>
        </div>
        <div data-stat="asleep">
          <dt>Asleep</dt>
          <dd>{overview?.summary.asleep ?? "–"}</dd>
        </div>
        <div data-stat="removed">
          <dt>Removed</dt>
          <dd>{overview?.summary.destroyed ?? "–"}</dd>
        </div>
      </dl>

      <div className="workspace">
        <section className="live-column">
          <div className="ledger-head">
            <div>
              <h2>Live</h2>
              <p className="help">Previews that are still running.</p>
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
            <label className="board-search">
              <span className="visually-hidden">Search by repo or branch</span>
              <input
                type="search"
                value={boardQuery}
                onChange={(event) => setBoardQuery(event.target.value)}
                placeholder="Search repo or branch"
              />
            </label>
          </div>

          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="empty">Loading the ledger…</p> : null}

          <div className="stack">
            {overview && current.length === 0 ? (
              <p className="empty">No live previews. Open a pull request and it will show up here.</p>
            ) : null}
            {overview && current.length > 0 && visible.length === 0 ? (
              <p className="empty">No previews match this filter.</p>
            ) : null}
            {visible.map((env) => (
              <EnvironmentCard
                key={env.id}
                env={env}
                copied={copiedId === env.id}
                sleepSeconds={config?.sleepSeconds ?? 20}
                now={now}
                demo={demoKey === `${env.repository}#${env.prNumber}`}
                buildsCode={dockerRuntime}
                costPerHour={overview?.costPerHour ?? 0.05}
                onCopy={() => void copyUrl(env.id, env.url ?? previewPath(""))}
              />
            ))}
          </div>

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
            <div className="stack">
              {removed.map((env) => (
                <EnvironmentCard
                  key={env.id}
                  env={env}
                  copied={copiedId === env.id}
                  sleepSeconds={config?.sleepSeconds ?? 20}
                  now={now}
                  demo={config?.demo === `${env.repository}#${env.prNumber}`}
                  buildsCode={dockerRuntime}
                  costPerHour={overview?.costPerHour ?? 0.05}
                  onCopy={() => void copyUrl(env.id, env.url ?? previewPath(""))}
                />
              ))}
            </div>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
        </section>
      </div>

      {config?.deployer === "fake" ? (
        <p className="footer">
          This site keeps the record. The preview itself runs on the computer where Mayfly is running.
        </p>
      ) : null}
    </main>
  );
}
