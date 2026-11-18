"use client";

import { useEffect, useRef, useState } from "react";
import type { Environment, EnvironmentStatus, UsageDay, UsageMonth } from "@/lib/types";
import {
  formatAgoRounded,
  formatEventTime,
  timelineLabel,
  timelineOldestFirst,
  timelineTone,
} from "@/lib/timeline";

/** Building blocks shared by the Dashboard, Activity, Cost & savings and Admin pages. */

export const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);
export const LIVE = new Set<EnvironmentStatus>(["provisioning", "ready", "updating", "destroying"]);
export const FAST_POLL_MS = 500;
export const LIVE_POLL_MS = 5000;

export type CardState = "running" | "sleeping" | "building" | "failed" | "destroying";
export type StatIconName = "live" | "running" | "sleeping" | "building" | "savings";

export function cardState(env: Environment): CardState {
  if (env.status === "failed") return "failed";
  if (env.status === "destroying") return "destroying";
  if (env.status === "provisioning" || env.status === "updating") return "building";
  if (env.sleep === "asleep") return "sleeping";
  return "running";
}

export function statePillLabel(state: CardState) {
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

function statePillIcon(state: CardState): StatIconName | null {
  if (state === "running") return "running";
  if (state === "sleeping") return "sleeping";
  if (state === "building") return "building";
  return null;
}

export function EnvironmentCard({
  env,
  now,
  demo,
  signedIn,
  busy,
  onAdminAction,
  onShowLifecycle,
}: {
  env: Environment;
  now: number;
  demo: boolean;
  signedIn: boolean;
  busy: boolean;
  onAdminAction: (env: Environment, action: "sleep" | "extend" | "destroy") => void;
  onShowLifecycle?: (env: Environment) => void;
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
  const pillIcon = statePillIcon(state);
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
          {pillIcon ? <StatIcon name={pillIcon} /> : null}
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
        {onShowLifecycle ? (
          <button type="button" className="secondary env-card-lifecycle" onClick={() => onShowLifecycle(env)}>
            Lifecycle
          </button>
        ) : null}
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
        ) : null}
      </footer>
    </article>
  );
}

/** Icons for the dashboard metric tiles (Live / Running / Sleeping / Building). */
export function StatIcon({ name }: { name: StatIconName }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  if (name === "live") {
    return (
      <svg {...props}>
        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" />
        <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
      </svg>
    );
  }
  if (name === "running") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 8.5v7l6-3.5-6-3.5z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "sleeping") {
    return (
      <svg {...props}>
        <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
        <path d="M16.2 5.2h2.2l-2.2 2.4h2.4M18.6 2.6h1.5l-1.5 1.6h1.6" />
      </svg>
    );
  }
  if (name === "building") {
    return (
      <svg {...props}>
        <path d="m15 5 4 4-9.5 9.5H5.5v-4L15 5z" />
        <path d="m13.5 6.5 4 4" />
        <path d="M5 19.5h5" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <ellipse cx="12" cy="7" rx="6" ry="2.4" />
      <path d="M6 7v3c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V7" />
      <path d="M6 10v3c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-3" />
      <path d="M6 13v3c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-3" />
    </svg>
  );
}

export function StateIcon({ name }: { name: "moon" | "sun" | "clock" | "alert" | "check" | "trash" }) {
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

export type Point = [number, number];

/** One isometric box: top face plus the two front faces, from its top-back corner. */
export function isoBox(ox: number, oy: number, w: number, d: number, h: number) {
  const u: Point = [0.866, 0.5];
  const v: Point = [-0.866, 0.5];
  const at = (a: number, b: number, down = 0): Point => [ox + a * u[0] + b * v[0], oy + a * u[1] + b * v[1] + down];
  const pts = (list: Point[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return {
    top: pts([at(0, 0), at(w, 0), at(w, d), at(0, d)]),
    left: pts([at(0, d), at(w, d), at(w, d, h), at(0, d, h)]),
    right: pts([at(w, 0), at(w, d), at(w, d, h), at(w, 0, h)]),
  };
}

/** Original decorative art for the sidebar card: glowing isometric "preview" boxes on a platform. */
export function PromoArt() {
  const base: Point = [100, 66];
  const onPlatform = (a: number, b: number, size: number): [number, number, number, number, number] => [
    base[0] + a * 0.866 - b * 0.866,
    base[1] + a * 0.5 + b * 0.5 - size,
    size,
    size,
    size,
  ];
  const platform = isoBox(base[0], base[1], 62, 62, 9);
  const boxes = [onPlatform(8, 6, 36), onPlatform(6, 36, 21), onPlatform(40, 30, 15)].map((args) => isoBox(...args));
  return (
    <svg className="board-promo-art" viewBox="0 0 200 142" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="promo-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#3dd6a5" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#3dd6a5" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="promo-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a7f3d0" />
          <stop offset="100%" stopColor="#4ade9f" />
        </linearGradient>
        <linearGradient id="promo-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c58b" />
          <stop offset="100%" stopColor="#0b7a57" />
        </linearGradient>
        <linearGradient id="promo-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f8f6b" />
          <stop offset="100%" stopColor="#064e3b" />
        </linearGradient>
        <linearGradient id="promo-slab" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1f6f57" />
          <stop offset="100%" stopColor="#0d3b30" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="104" rx="96" ry="38" fill="url(#promo-glow)" />
      <g className="board-promo-slab">
        <polygon points={platform.top} fill="url(#promo-slab)" />
        <polygon points={platform.left} fill="#0b2f27" />
        <polygon points={platform.right} fill="#082520" />
      </g>
      {boxes.map((box, index) => (
        <g key={index} className="board-promo-box">
          <polygon points={box.left} fill="url(#promo-left)" />
          <polygon points={box.right} fill="url(#promo-right)" />
          <polygon points={box.top} fill="url(#promo-top)" />
        </g>
      ))}
    </svg>
  );
}

export function previewPath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Sandboxed previews cannot read localStorage; pass the board theme in the URL. */
export function previewHref(url: string | null | undefined) {
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

export function formatDelta(iso: string) {
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

export function formatAgo(iso: string, now: number) {
  return formatAgoRounded(iso, now);
}

export function formatDayLabel(key: string) {
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(ms)) return key;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatSleep(seconds: number) {
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

export function formatLifetime(hours: number) {
  if (hours >= 48) {
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day" : `${days} days`;
  }
  return `${hours} h`;
}

export function formatSaved(amount: number, currency = "$") {
  // Exactly nothing is "$0.00"; "< $0.01" is only for a real amount too small to show.
  if (!Number.isFinite(amount) || amount <= 0) return `${currency}0.00`;
  if (amount < 0.01) return `< ${currency}0.01`;
  return `≈ ${currency}${amount.toFixed(2)}`;
}

export function estimatedCost(seconds: number, costPerHour: number) {
  return (seconds / 3600) * costPerHour;
}

export function formatEstMoney(amount: number, currency = "$") {
  if (!Number.isFinite(amount) || amount <= 0) return `${currency}0.00`;
  if (amount < 0.01) return `< ${currency}0.01`;
  return `${currency}${amount.toFixed(2)}`;
}

export function dayTotals(days: Record<string, UsageDay> | undefined, key: string): UsageDay {
  const day = days?.[key];
  return {
    awakeSeconds: day?.awakeSeconds ?? 0,
    asleepSeconds: day?.asleepSeconds ?? 0,
  };
}

export function monthDayKeys(usage: UsageMonth | undefined) {
  const month = usage?.month ?? new Date().toISOString().slice(0, 7);
  const keys = Object.keys(usage?.days ?? {})
    .filter((key) => key.startsWith(`${month}-`))
    .sort();
  if (keys.length > 0) return keys;
  // Still draw an empty baseline for the current UTC day so the chart has shape.
  return [`${month}-${String(new Date().getUTCDate()).padStart(2, "0")}`];
}

/** Cumulative estimated spend: always-awake vs with Mayfly, from usage.days. */
export function CostUsageChart({
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

  const firstLabel = keys[0] ? formatDayLabel(keys[0]) : "";
  const lastLabel = keys.length > 1 ? formatDayLabel(keys[keys.length - 1]) : "";
  const single = points.length < 2;
  const day = points[points.length - 1];
  // Leave 16px above the tallest bar for its value label.
  const barMax = (Math.max(day?.always ?? 0, day?.mayfly ?? 0) || 1) * (innerH / Math.max(1, innerH - 16));
  const barW = 56;
  const barGap = 28;
  const barLeft = padL + innerW / 2 - barW - barGap / 2;

  return (
    <figure className="cost-line-chart" aria-label="Estimated cumulative spend this month">
      {single ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
          <line className="cost-line-axis" x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} />
          {day ? (
            <>
              <rect
                className="cost-bar-always"
                x={barLeft}
                y={padT + innerH - (day.always / barMax) * innerH}
                width={barW}
                height={Math.max(1, (day.always / barMax) * innerH)}
                rx={4}
              />
              <rect
                className="cost-bar-mayfly"
                x={barLeft + barW + barGap}
                y={padT + innerH - Math.max(1, (day.mayfly / barMax) * innerH)}
                width={barW}
                height={Math.max(1, (day.mayfly / barMax) * innerH)}
                rx={4}
              />
              <text className="cost-bar-value" x={barLeft + barW / 2} y={Math.max(10, padT + innerH - (day.always / barMax) * innerH - 4)} textAnchor="middle">
                {formatEstMoney(day.always, currency)}
              </text>
              <text className="cost-bar-value" x={barLeft + barW * 1.5 + barGap} y={padT + innerH - Math.max(1, (day.mayfly / barMax) * innerH) - 4} textAnchor="middle">
                {formatEstMoney(day.mayfly, currency)}
              </text>
            </>
          ) : null}
          <text className="cost-line-edge" x={padL + innerW / 2} y={height - 2} textAnchor="middle">
            {firstLabel}
          </text>
        </svg>
      ) : (
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
      )}
      {single ? <p className="cost-chart-note">The daily chart fills in as days pass.</p> : null}
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

export function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs ? `${mins} min ${secs} s` : `${mins} min`;
}

export type BoardFilter = "all" | "awake" | "asleep" | "expiring";

export const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

export function matchesBoardFilter(env: Environment, filter: BoardFilter, now: number, demoKey: string | null) {
  if (filter === "all") return true;
  if (filter === "awake") return env.sleep === "awake" || env.sleep === "waking";
  if (filter === "asleep") return env.sleep === "asleep";
  if (filter === "expiring") {
    if (demoKey && demoKey === `${env.repository}#${env.prNumber}`) return false;
    if (env.keptByLabel || !env.expiresAt) return false;
    const left = Date.parse(env.expiresAt) - now;
    return Number.isFinite(left) && left > 0 && left <= EXPIRING_SOON_MS;
  }
  return true;
}

export function matchesBoardSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber).includes(q) ||
    env.sha.toLowerCase().includes(q)
  );
}

export type BoardActivity = {
  at: string;
  /** "PR #12", "Demo", or "6 previews" for a grouped burst. */
  subject: string;
  /** Repository to show, only when the board has more than one repository. */
  repository: string | null;
  type: string;
  label: string;
  icon: "moon" | "sun" | "clock" | "alert" | "check" | "trash";
};

export function activityLabel(type: string, count = 1) {
  switch (type) {
    case "opened":
      return "opened";
    case "build_started":
      return "build started";
    case "built":
      return "built";
    case "ready":
      return "ready";
    case "updated":
      return "updated";
    case "keep_awake":
      return "kept awake";
    case "keep_awake_off":
      return "keep awake off";
    case "slept":
      return "slept";
    case "woke":
      return count > 1 ? "woke" : "woken by a visit";
    case "extended":
      return "extended";
    case "failed":
      return "failed";
    case "destroyed":
      return "removed";
    default:
      return type.replace(/_/g, " ");
  }
}

export function activityIcon(type: string): BoardActivity["icon"] {
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

export const BURST_MS = 2 * 60 * 1000;
export const BURST_TYPES = new Set(["slept", "woke"]);

/** Newest timeline events across all previews (real env.events only); sleep/wake bursts grouped. */
export function boardRecentActivity(environments: Environment[], demoKey: string | null): BoardActivity[] {
  const repos = new Set(
    environments.filter((env) => `${env.repository}#${env.prNumber}` !== demoKey).map((env) => env.repository),
  );
  const showRepo = repos.size > 1;
  const raw: { at: string; env: Environment; type: string; demo: boolean }[] = [];
  for (const env of environments) {
    const demo = `${env.repository}#${env.prNumber}` === demoKey;
    // Newest first per preview, so same-moment events (built, then ready) keep their order after the sort.
    for (const event of timelineOldestFirst(env.events).reverse()) raw.push({ at: event.at, env, type: event.type, demo });
  }
  raw.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const items: BoardActivity[] = [];
  for (let i = 0; i < raw.length && items.length < 8; ) {
    const first = raw[i];
    let j = i + 1;
    if (BURST_TYPES.has(first.type)) {
      while (
        j < raw.length &&
        raw[j].type === first.type &&
        Date.parse(first.at) - Date.parse(raw[j].at) <= BURST_MS
      ) {
        j += 1;
      }
    }
    const count = j - i;
    if (count > 1) {
      items.push({
        at: first.at,
        subject: `${count} previews`,
        repository: null,
        type: first.type,
        label: activityLabel(first.type, count),
        icon: activityIcon(first.type),
      });
    } else {
      items.push({
        at: first.at,
        subject: first.demo ? "Demo" : `PR #${first.env.prNumber}`,
        repository: showRepo && !first.demo ? first.env.repository : null,
        type: first.type,
        label: activityLabel(first.type),
        icon: activityIcon(first.type),
      });
    }
    i = j;
  }
  return items;
}

export function LifecycleDrawer({
  env,
  demo,
  onClose,
}: {
  env: Environment | null;
  demo: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (env && !dialog.open) dialog.showModal();
    if (!env && dialog.open) dialog.close();
  }, [env]);

  const events = env ? timelineOldestFirst(env.events) : [];
  const state = env ? cardState(env) : "running";

  return (
    <dialog
      ref={dialogRef}
      className="lifecycle-drawer"
      aria-labelledby="lifecycle-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {env ? (
        <div className="lifecycle-inner">
          <header className="lifecycle-head">
            <div>
              <h2 id="lifecycle-title">
                {demo ? "Demo" : `PR #${env.prNumber}`} — Lifecycle
              </h2>
              <p className="lifecycle-sub">
                <span className="mono">{demo ? "demo" : env.branch}</span> · {env.repository}
              </p>
            </div>
            <button type="button" className="secondary lifecycle-close" onClick={onClose}>
              Close
            </button>
          </header>
          <p className="lifecycle-state">
            <span className="state-pill" data-state={state}>
              {statePillIcon(state) ? <StatIcon name={statePillIcon(state)!} /> : null}
              {statePillLabel(state)}
            </span>
            <span className="mono">{env.sha.slice(0, 8)}</span>
          </p>
          {events.length === 0 ? (
            <p className="empty">No history yet — events are recorded from now on.</p>
          ) : (
            <ol className="lifecycle-list">
              {events.map((event, index) => (
                <li key={`${event.at}-${event.type}-${index}`} data-tone={timelineTone(event.type)}>
                  <span className="lifecycle-dot" aria-hidden="true" />
                  <div>
                    <strong>{timelineLabel(event)}</strong>
                    <time dateTime={event.at}>{formatEventTime(event.at)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="lifecycle-foot">Mayfly keeps the last 50 events for each preview.</p>
        </div>
      ) : null}
    </dialog>
  );
}

export const VIEW_STORAGE_KEY = "mayfly-board-view";

export function readStoredView(): "grid" | "list" {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "grid" || raw === "list") return raw;
  } catch {
    // Storage can be blocked.
  }
  return "grid";
}

export function writeStoredView(view: "grid" | "list") {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be blocked.
  }
}

