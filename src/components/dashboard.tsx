"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MayflyMark } from "@/components/admin-header";
import { ThemeToggle } from "@/components/theme-toggle";
import type { Environment, EnvironmentStatus, Overview, UsageDay, UsageMonth } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
const FAST_POLL_MS = 500;
const LIVE_POLL_MS = 5000;

type CardState = "running" | "sleeping" | "building" | "failed" | "destroying";

function cardState(env: Environment): CardState {
  if (env.status === "failed") return "failed";
  if (env.status === "destroying") return "destroying";
  if (env.status === "provisioning" || env.status === "updating") return "building";
  if (env.sleep === "asleep") return "sleeping";
  return "running";
}

function statePillLabel(state: CardState) {
  switch (state) {
    case "running":
      return "Running";
    case "sleeping":
      return "Sleeping";
    case "building":
      return "Building";
    case "failed":
      return "Failed";
    case "destroying":
      return "Destroying";
  }
}

function EnvironmentCard({
  env,
  now,
  demo,
  signedIn,
  busy,
  onAdminAction,
}: {
  env: Environment;
  now: number;
  demo: boolean;
  signedIn: boolean;
  busy: boolean;
  onAdminAction: (env: Environment, action: "sleep" | "extend" | "destroy") => void;
}) {
  const [showError, setShowError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const state = cardState(env);
  const href = previewHref(env.url);
  const canOpen = Boolean(href) && state !== "building" && state !== "destroying";

  return (
    <article className="env env-card" data-state={state} data-status={env.status}>
      <header className="env-card-head">
        <div className="env-card-titles">
          <h3>
            PR #{env.prNumber}
            {demo ? <span className="env-card-demo"> · demo</span> : null}
          </h3>
          <p className="card-repo">{env.repository}</p>
        </div>
        <span className="state-pill" data-state={state}>
          {statePillLabel(state)}
        </span>
      </header>
      <div className="card-body env-card-body">
        <p className="env-card-meta">
          <span>
            <span className="fact-label">Branch</span>{" "}
            <span className="mono">{demo ? "demo" : env.branch}</span>
          </span>
          <span>
            <span className="fact-label">Commit</span>{" "}
            <span className="mono">{env.sha.slice(0, 8)}</span>
          </span>
          <span>
            <span className="fact-label">Built in</span>{" "}
            {typeof env.buildMs === "number" && env.buildMs >= 0 ? formatDurationMs(env.buildMs) : "–"}
          </span>
          <span>
            <span className="fact-label">Last visit</span> {formatAgo(env.lastActiveAt, now)}
          </span>
        </p>
        {showError && env.error ? <pre className="fail-box">{env.error}</pre> : null}
      </div>
      <footer className="card-foot env-card-foot">
        {state === "failed" ? (
          <button type="button" className="open-preview secondary" onClick={() => setShowError((open) => !open)}>
            {showError ? "Hide error" : "View error"}
          </button>
        ) : state === "sleeping" ? (
          canOpen ? (
            <a className="open-preview" href={href}>
              Wake up
            </a>
          ) : (
            <button type="button" className="open-preview" disabled>
              Wake up
            </button>
          )
        ) : state === "building" || state === "destroying" ? (
          <button type="button" className="open-preview" disabled>
            {state === "building" ? "Building…" : "Destroying…"}
          </button>
        ) : canOpen ? (
          <a className="open-preview" href={href}>
            Open preview
          </a>
        ) : (
          <button type="button" className="open-preview" disabled>
            Open preview
          </button>
        )}
        {signedIn && !demo ? (
          <div className="env-card-menu">
            <button
              type="button"
              className="env-card-menu-btn secondary"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              disabled={busy || state === "destroying"}
              onClick={() => setMenuOpen((open) => !open)}
            >
              …
            </button>
            {menuOpen ? (
              <div className="env-card-menu-panel" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy || state !== "running"}
                  onClick={() => {
                    setMenuOpen(false);
                    onAdminAction(env, "sleep");
                  }}
                >
                  Sleep
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onAdminAction(env, "extend");
                  }}
                >
                  Extend
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onAdminAction(env, "destroy");
                  }}
                >
                  Destroy
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <span />
        )}
      </footer>
    </article>
  );
}

function StateIcon({ name }: { name: "moon" | "sun" | "clock" | "alert" | "check" | "trash" }) {
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
  if (name === "check") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    );
  }
  if (name === "trash") {
    return (
      <svg {...props}>
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
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

function formatSaved(amount: number, currency = "$") {
  if (amount < 0.01) return `< ${currency}0.01`;
  return `≈ ${currency}${amount.toFixed(2)}`;
}

function estimatedCost(seconds: number, costPerHour: number) {
  return (seconds / 3600) * costPerHour;
}

function formatEstMoney(amount: number, currency = "$") {
  if (!Number.isFinite(amount) || amount < 0.01) return `< ${currency}0.01`;
  return `${currency}${amount.toFixed(2)}`;
}

function dayTotals(days: Record<string, UsageDay> | undefined, key: string): UsageDay {
  const day = days?.[key];
  return {
    awakeSeconds: day?.awakeSeconds ?? 0,
    asleepSeconds: day?.asleepSeconds ?? 0,
  };
}

function monthDayKeys(usage: UsageMonth | undefined) {
  const month = usage?.month ?? new Date().toISOString().slice(0, 7);
  const keys = Object.keys(usage?.days ?? {})
    .filter((key) => key.startsWith(`${month}-`))
    .sort();
  if (keys.length > 0) return keys;
  // Still draw an empty baseline for the current UTC day so the chart has shape.
  return [`${month}-${String(new Date().getUTCDate()).padStart(2, "0")}`];
}

/** Cumulative estimated spend: always-awake vs with Mayfly, from usage.days. */
function CostUsageChart({
  usage,
  costPerHour,
  currency = "$",
}: {
  usage: UsageMonth | undefined;
  costPerHour: number;
  currency?: string;
}) {
  const keys = monthDayKeys(usage);
  let alwaysCum = 0;
  let mayflyCum = 0;
  const points = keys.map((key) => {
    const day = dayTotals(usage?.days, key);
    alwaysCum += estimatedCost(day.awakeSeconds + day.asleepSeconds, costPerHour);
    mayflyCum += estimatedCost(day.awakeSeconds, costPerHour);
    return { key, always: alwaysCum, mayfly: mayflyCum };
  });

  const alwaysTotal = estimatedCost((usage?.awakeSeconds ?? 0) + (usage?.asleepSeconds ?? 0), costPerHour);
  const mayflyTotal = estimatedCost(usage?.awakeSeconds ?? 0, costPerHour);
  const maxValue = Math.max(alwaysTotal, mayflyCum, alwaysCum, 0.01);

  const width = 320;
  const height = 140;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  function xAt(index: number) {
    if (points.length <= 1) return padL + innerW / 2;
    return padL + (index / (points.length - 1)) * innerW;
  }
  function yAt(value: number) {
    return padT + innerH - (value / maxValue) * innerH;
  }

  function linePath(pick: "always" | "mayfly") {
    return points
      .map((point, index) => {
        const x = xAt(index);
        const y = yAt(pick === "always" ? point.always : point.mayfly);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }

  const firstLabel = keys[0]?.slice(8) ?? "";
  const lastLabel = keys[keys.length - 1]?.slice(8) ?? "";

  return (
    <figure className="cost-line-chart" aria-label="Estimated cumulative spend this month">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
        <line
          className="cost-line-axis"
          x1={padL}
          y1={padT + innerH}
          x2={padL + innerW}
          y2={padT + innerH}
        />
        <path className="cost-line cost-line-always" d={linePath("always")} fill="none" />
        <path className="cost-line cost-line-mayfly" d={linePath("mayfly")} fill="none" />
        <text className="cost-line-edge" x={padL} y={height - 2}>
          {firstLabel}
        </text>
        <text className="cost-line-edge" x={padL + innerW} y={height - 2} textAnchor="end">
          {lastLabel}
        </text>
      </svg>
      <dl className="cost-line-totals">
        <div>
          <dt>Estimated if always awake</dt>
          <dd>{formatEstMoney(alwaysTotal, currency)}</dd>
        </div>
        <div>
          <dt>Estimated with Mayfly</dt>
          <dd>{formatEstMoney(mayflyTotal, currency)}</dd>
        </div>
      </dl>
      <figcaption className="cost-chart-legend">
        <span>
          <i className="cost-swatch cost-swatch-always" aria-hidden="true" /> Estimated always awake
        </span>
        <span>
          <i className="cost-swatch cost-swatch-actual" aria-hidden="true" /> Estimated with Mayfly
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

type BoardActivity = {
  at: string;
  repository: string;
  prNumber: number;
  type: string;
  label: string;
  icon: "moon" | "sun" | "clock" | "alert" | "check" | "trash";
};

function activityLabel(type: string) {
  switch (type) {
    case "build_started":
      return "build started";
    case "keep_awake":
      return "keep awake";
    case "keep_awake_off":
      return "keep awake off";
    case "slept":
      return "slept";
    case "woke":
      return "woke";
    default:
      return type.replace(/_/g, " ");
  }
}

function activityIcon(type: string): BoardActivity["icon"] {
  switch (type) {
    case "slept":
      return "moon";
    case "woke":
    case "ready":
    case "opened":
      return "check";
    case "build_started":
    case "built":
    case "updated":
    case "extended":
    case "keep_awake":
      return "clock";
    case "failed":
      return "alert";
    case "destroyed":
      return "trash";
    default:
      return "sun";
  }
}

/** Newest timeline events across all previews (real env.events only). */
function boardRecentActivity(environments: Environment[]): BoardActivity[] {
  const events: BoardActivity[] = [];
  for (const env of environments) {
    for (const event of env.events ?? []) {
      events.push({
        at: event.at,
        repository: env.repository,
        prNumber: env.prNumber,
        type: event.type,
        label: activityLabel(event.type),
        icon: activityIcon(event.type),
      });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8);
}

const VIEW_STORAGE_KEY = "mayfly-board-view";

function readStoredView(): "grid" | "list" {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "grid" || raw === "list") return raw;
  } catch {
    // Storage can be blocked.
  }
  return "grid";
}

function writeStoredView(view: "grid" | "list") {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be blocked.
  }
}

export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [boardQuery, setBoardQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [signedIn, setSignedIn] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [cardView, setCardView] = useState<"grid" | "list">("grid");
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    setCardView(readStoredView());
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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  function chooseTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mayfly-theme", next);
    } catch {
      // Storage can be blocked.
    }
    setTheme(next);
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    setSignedIn(false);
  }

  const config = overview?.config;
  const currency = overview?.currency ?? config?.currency ?? "$";
  const current = overview?.environments.filter((env) => env.status !== "destroyed") ?? [];
  const demoKey = config?.demo ?? null;
  const visible = current.filter(
    (env) => matchesBoardFilter(env, boardFilter, now, demoKey) && matchesBoardSearch(env, boardQuery),
  );
  const removed = overview?.environments.filter((env) => env.status === "destroyed") ?? [];
  const dockerRuntime = config?.allowedRepositories != null;
  const liveCount = overview?.summary.live ?? 0;
  const capacity = config?.maxConcurrent ?? 0;
  const capacityRatio = capacity > 0 ? Math.min(1, liveCount / capacity) : 0;
  const buildingCount = current.filter(
    (env) => env.status === "provisioning" || env.status === "updating",
  ).length;
  const activity = overview ? boardRecentActivity(overview.environments) : [];
  const costPerHour = overview?.costPerHour ?? 0.05;
  const alwaysAwakeEstimate = overview
    ? estimatedCost((overview.usage?.awakeSeconds ?? 0) + (overview.usage?.asleepSeconds ?? 0), costPerHour)
    : 0;
  const withMayflyEstimate = overview ? estimatedCost(overview.usage?.awakeSeconds ?? 0, costPerHour) : 0;

  return (
    <div className="board-app" data-nav={navOpen ? "open" : "closed"}>
      <aside className="board-sidebar" aria-label="Mayfly">
        <div className="board-sidebar-brand">
          <a className="board-brand" href="/">
            <MayflyMark className="board-mark" />
            <span>
              <span className="board-wordmark">Mayfly</span>
              <span className="board-tagline">Ephemeral Environments</span>
            </span>
          </a>
          <button
            type="button"
            className="board-nav-toggle"
            aria-expanded={navOpen}
            aria-controls="board-side-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <nav id="board-side-nav" className="board-side-nav">
          <a href="/board" aria-current="page">
            Dashboard
          </a>
          <a href="#cost" onClick={() => setNavOpen(false)}>
            Cost &amp; savings
          </a>
          <a href="#activity" onClick={() => setNavOpen(false)}>
            Activity
          </a>
          <a href="/admin">Admin</a>
        </nav>
        <p className="board-promo">Spin up PR previews on demand. Sleep when idle. Save on cloud costs.</p>
      </aside>

      <div className="board-main">
        <header className="board-topbar">
          <label className="board-search board-search-top">
            <span className="visually-hidden">Search by repo or branch</span>
            <input
              ref={searchRef}
              type="search"
              value={boardQuery}
              onChange={(event) => setBoardQuery(event.target.value)}
              placeholder="Search repo or branch"
            />
            <kbd className="board-search-kbd">Ctrl K</kbd>
          </label>
          <div className="board-topbar-actions">
            {config?.githubConnected ? (
              <span className="board-github-pill" title="GitHub token is configured">
                GitHub connected
              </span>
            ) : null}
            <ThemeToggle theme={theme} onChange={chooseTheme} />
            {signedIn ? (
              <button type="button" className="secondary board-auth-btn" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : (
              <a className="btn secondary board-auth-btn" href="/admin/login">
                Admin sign-in
              </a>
            )}
          </div>
        </header>

        <main className="board-content">
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
                Ephemeral preview environments for every pull request — build, preview, sleep and destroy
                automatically.
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
              <dt>Running</dt>
              <dd>{overview?.summary.awake ?? "–"}</dd>
            </div>
            <div data-stat="asleep">
              <dt>Sleeping</dt>
              <dd>{overview?.summary.asleep ?? "–"}</dd>
            </div>
            <div data-stat="building">
              <dt>Building</dt>
              <dd>{overview ? buildingCount : "–"}</dd>
            </div>
            <div data-stat="savings">
              <dt>Estimated</dt>
              <dd>{overview ? formatSaved(overview.savedEstimate, currency) : "–"}</dd>
            </div>
          </dl>

          <p className="board-settings">
            {config
              ? `Sleeps after ${formatSleep(config.sleepSeconds)} · Max lifetime ${formatLifetime(config.ttlHours)}`
              : "Sleeps after – · Max lifetime –"}
          </p>

          <div className="board-workspace">
            <section className="live-column">
              <div className="ledger-head">
                <div>
                  <h2>Active environments</h2>
                  <p className="help">Previews that are still running.</p>
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
              {!overview && !loadError ? <p className="empty">Loading the ledger…</p> : null}

              <div className="stack env-card-stack" data-view={cardView}>
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
                    now={now}
                    demo={demoKey === `${env.repository}#${env.prNumber}`}
                    signedIn={signedIn}
                    busy={busy}
                    onAdminAction={(item, action) => void adminAction(item, action)}
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
                    />
                  ))}
                </div>
              ) : null}
              {error ? <p className="error" role="alert">{error}</p> : null}
            </section>

            <aside className="board-rail">
              <section id="cost" className="board-rail-card" aria-label="Estimated cost and usage">
                <h2 className="board-rail-title">Cost &amp; Usage</h2>
                <p className="savings-sub">
                  {overview
                    ? `Estimated always awake ${formatEstMoney(alwaysAwakeEstimate, currency)} · Estimated with Mayfly ${formatEstMoney(withMayflyEstimate, currency)}`
                    : "Waiting for the first reaper sample…"}
                </p>
                {overview ? (
                  <CostUsageChart usage={overview.usage} costPerHour={costPerHour} currency={currency} />
                ) : null}
              </section>

              <section id="activity" className="board-rail-card board-activity" aria-label="Recent activity">
                <h2 className="board-rail-title">Recent activity</h2>
                {activity.length === 0 ? (
                  <p className="empty">No activity yet.</p>
                ) : (
                  <ol className="board-activity-list">
                    {activity.map((item, index) => (
                      <li key={`${item.at}-${item.repository}-${item.prNumber}-${item.type}-${index}`} data-tone={item.icon}>
                        <span className="board-activity-icon" aria-hidden="true">
                          <StateIcon name={item.icon} />
                        </span>
                        <div>
                          <strong>
                            PR #{item.prNumber} {item.label}
                          </strong>
                          <span className="board-activity-repo">{item.repository}</span>
                          <time dateTime={item.at}>{formatAgo(item.at, now)}</time>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </aside>
          </div>

          {config?.deployer === "fake" ? (
            <p className="footer">
              This site keeps the record. The preview itself runs on the computer where Mayfly is running.
            </p>
          ) : null}
        </main>
      </div>
    </div>
  );
}
