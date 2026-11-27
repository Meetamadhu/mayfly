"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewResources } from "@/lib/resources";
import type { Environment, EnvironmentStatus, UsageDay, UsageMonth } from "@/lib/types";
import { formatBytes, loadTone } from "@/lib/use-resources";
import { isProblemLine, summarizeFailure } from "@/lib/build-log";
import { explainFailure } from "@/lib/failure-help";
import { formatAgoRounded, timelineOldestFirst } from "@/lib/timeline";

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
      return "Awake";
    case "sleeping":
      return "Asleep";
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

type LifeState = "build" | "awake" | "asleep" | "unknown";

/** Split a preview's life so far into building / awake / asleep stretches, from its own history. */
function lifeSegments(env: Environment, start: number, now: number) {
  const events = timelineOldestFirst(env.events);
  const segments: { from: number; to: number; state: LifeState }[] = [];
  const first = events[0] ? Date.parse(events[0].at) : now;
  // Older history may have been trimmed (50 events kept): the part before it is unknown.
  let state: LifeState = first - start > 60_000 ? "unknown" : "build";
  let at = start;
  const move = (t: number, next: LifeState) => {
    const time = Math.min(Math.max(t, start), now);
    if (time > at) segments.push({ from: at, to: time, state });
    at = Math.max(at, time);
    state = next;
  };
  for (const event of events) {
    const t = Date.parse(event.at);
    if (!Number.isFinite(t)) continue;
    if (event.type === "opened" || event.type === "build_started" || event.type === "updated") move(t, "build");
    else if (event.type === "ready" || event.type === "woke" || event.type === "keep_awake") move(t, "awake");
    else if (event.type === "slept") move(t, "asleep");
  }
  if (env.sleep === "asleep" && (state as LifeState) === "awake") state = "asleep";
  move(now, state);
  return segments;
}

/** "in 5 days", "in 3 h", "in 12 min". */
function formatIn(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "any moment";
  if (minutes < 90) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * The preview's life on one line, from opening to its end: solid where it was awake, faint where it slept,
 * striped while it built, dashed for the time it has left. A mayfly lives for a day; so does a preview.
 */
export function Lifespan({ env, now, demo }: { env: Environment; now: number; demo: boolean }) {
  const start = Date.parse(env.createdAt);
  if (!Number.isFinite(start)) return null;
  const endMs = Date.parse(env.expiresAt);
  const openEnded = demo || Boolean(env.keptByLabel) || !Number.isFinite(endMs);
  const end = openEnded ? now + Math.max(now - start, 60_000) * 0.25 : Math.max(endMs, now);
  const span = Math.max(end - start, 1);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - start) / span) * 100));
  const nowPct = pct(now);
  const segments = lifeSegments(env, start, now);
  const usage = env.usage;
  const total = usage ? usage.awakeSeconds + usage.asleepSeconds : 0;
  const awakeShare = usage && total > 0 ? Math.round((usage.awakeSeconds / total) * 100) : null;
  const right = demo
    ? "Always on"
    : env.keptByLabel
      ? "Kept open by label"
      : endMs <= now
        ? "Ending now"
        : `Ends ${formatIn(endMs - now)}`;
  const label = [
    `Opened ${formatAgo(env.createdAt, now)}.`,
    `${right}.`,
    awakeShare === null ? "" : `Awake ${awakeShare}% of the time so far.`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="lifespan" role="img" aria-label={label} data-open-ended={openEnded ? "true" : "false"}>
      <div className="lifespan-track">
        {segments.map((segment, index) => (
          <span
            key={index}
            className="lifespan-seg"
            data-life={segment.state}
            style={{ left: `${pct(segment.from)}%`, width: `${pct(segment.to) - pct(segment.from)}%` }}
          />
        ))}
        <span className="lifespan-left" style={{ left: `${nowPct}%`, width: `${100 - nowPct}%` }} />
        <span className="lifespan-now" style={{ left: `${nowPct}%` }} />
      </div>
      <p className="lifespan-ends" aria-hidden="true">
        <span>Opened {formatAgo(env.createdAt, now)}</span>
        {awakeShare === null ? null : <span className="lifespan-share">{awakeShare}% awake</span>}
        <span>{right}</span>
      </p>
    </div>
  );
}

export function EnvironmentCard({
  env,
  now,
  demo,
  signedIn,
  busy,
  onAdminAction,
  onShowLifecycle,
  onPickAuthor,
  resources,
  measured = false,
}: {
  env: Environment;
  /** CPU and memory while it's awake; absent when asleep or not read yet. */
  resources?: PreviewResources;
  /** True when this server can measure previews at all (false for simulated previews). */
  measured?: boolean;
  now: number;
  demo: boolean;
  signedIn: boolean;
  busy: boolean;
  /** When given, the "@login" on the card shows only that person's previews. */
  onPickAuthor?: (login: string) => void;
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
            {demo ? "Demo preview" : `PR #${env.prNumber}`}
            <span className="card-repo">{env.repository}</span>
          </h3>
          <p className="env-card-branch mono">{demo ? "demo" : env.branch}</p>
        </div>
        <span className="state-pill" data-state={state}>
          {pillIcon ? <StatIcon name={pillIcon} /> : null}
          {statePillLabel(state)}
        </span>
      </header>
      <div className="card-body env-card-body">
        <Lifespan env={env} now={now} demo={demo} />
        <p className="env-card-facts">
          <OpenedBy env={env} onPick={onPickAuthor} />
          Commit <span className="mono">{env.sha.slice(0, 7)}</span>
          {typeof env.buildMs === "number" && env.buildMs >= 0 ? `, built in ${formatDurationMs(env.buildMs)}` : ""}.
          {" "}Last visited {formatAgo(env.lastActiveAt, now)}.
        </p>
        {state === "running" && resources ? <CardResources usage={resources} /> : null}
        {state === "running" && !resources && measured ? (
          <p className="card-res-note">Measuring CPU and memory…</p>
        ) : null}
        {state === "sleeping" && measured ? (
          <p className="card-res-note">Asleep, so it uses no CPU or memory right now.</p>
        ) : null}
        {state === "failed" && env.error ? <FailureSummary error={env.error} signedIn={signedIn} /> : null}
        {showError && signedIn && env.error ? <BuildLog error={env.error} /> : null}
      </div>
      <footer className="card-foot env-card-foot">
        {state === "failed" ? (
          signedIn ? (
            <button type="button" className="open-preview secondary" onClick={() => setShowError((open) => !open)}>
              {showError ? "Hide build log" : "View build log"}
            </button>
          ) : null
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
            {state === "building" ? "Building…" : "Removing…"}
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
            History
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
                  Put to sleep
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
                  Extend by 4 h
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
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </footer>
    </article>
  );
}

/** On a failed card, always visible: what failed, and the line most likely to say why. */
export function FailureSummary({ error, signedIn }: { error: string; signedIn: boolean }) {
  const { headline, hint } = summarizeFailure(error);
  const help = explainFailure(error);
  return (
    <div className="fail-summary">
      <strong>{headline}</strong>
      {hint ? <code>{hint}</code> : null}
      {help ? (
        // Plain words for everyone, including people who can't open the build log.
        <div className="fail-help">
          <p className="fail-help-title">{help.title}</p>
          <p className="fail-help-label">What to try</p>
          <ol>
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {signedIn ? null : (
        // Visitors only get the first line: build output can include internal paths or values.
        <span className="fail-summary-note">
          <a href="/admin/login">Sign in as admin</a> to see the build log.
        </span>
      )}
    </div>
  );
}

/** Behind "View build log": the last lines of the build, problem lines marked, with a copy button. */
export function BuildLog({ error }: { error: string }) {
  const { headline, log } = summarizeFailure(error);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // The useful part is at the end, so start there.
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [error]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (log.length === 0) return <pre className="fail-box">{headline}</pre>;
  return (
    <div className="build-log">
      <div className="build-log-head">
        <span>
          Last {log.length} {log.length === 1 ? "line" : "lines"} of the build
        </span>
        <button type="button" className="build-log-copy" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="build-log-box" ref={boxRef} tabIndex={0} aria-label="Build log">
        {log.map((line, index) => (
          <span key={index} className={isProblemLine(line) ? "build-log-problem" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

type AppLogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; lines: string[]; at: number }
  | { status: "error"; message: string };

/**
 * For admins, on a running preview: what the app printed (its console output), read from the preview's gate on
 * demand. A page that is blank or an error that only shows once the app runs is usually explained in these lines.
 */
export function AppLog({ envId }: { envId: string }) {
  const [log, setLog] = useState<AppLogState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

  async function load() {
    setLog({ status: "loading" });
    try {
      const response = await fetch(`/api/environments/${encodeURIComponent(envId)}/logs`, { credentials: "include", cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; lines?: string[]; error?: string };
      if (response.ok && body.ok && Array.isArray(body.lines)) setLog({ status: "ready", lines: body.lines, at: Date.now() });
      else setLog({ status: "error", message: body.error ?? "Couldn't read the app's output. Please try again." });
    } catch {
      setLog({ status: "error", message: "Couldn't read the app's output. Please try again." });
    }
  }

  useEffect(() => {
    // The newest lines are at the end, so start there.
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log]);

  async function copy() {
    if (log.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(log.lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (log.status === "idle" || log.status === "loading") {
    return (
      <button type="button" className="pd-btn pd-btn-line" disabled={log.status === "loading"} onClick={() => void load()}>
        {log.status === "loading" ? "Reading…" : "Show what the app printed"}
      </button>
    );
  }
  if (log.status === "error") {
    return (
      <div>
        <p className="pd-hint" role="alert">
          {log.message}
        </p>
        <button type="button" className="pd-btn pd-btn-line" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="build-log">
      <div className="build-log-head">
        <span>{log.lines.length === 0 ? "Nothing printed yet" : `Last ${log.lines.length} ${log.lines.length === 1 ? "line" : "lines"} the app printed`}</span>
        <span className="build-log-actions">
          <button type="button" className="build-log-copy" onClick={() => void load()}>
            Refresh
          </button>
          {log.lines.length > 0 ? (
            <button type="button" className="build-log-copy" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </span>
      </div>
      <pre className="build-log-box" ref={boxRef} tabIndex={0} aria-label="App output">
        {log.lines.length === 0
          ? "The app hasn't printed anything since it last started."
          : log.lines.map((line, index) => (
              <span key={index} className={isProblemLine(line) ? "build-log-problem" : undefined}>
                {line}
                {"\n"}
              </span>
            ))}
      </pre>
    </div>
  );
}

/**
 * On an awake preview's card: CPU and memory. In Docker both are shares of the container's limits; a plain-process
 * preview has no memory limit, so it shows the amount used and CPU as a share of one CPU.
 */
export function CardResources({ usage }: { usage: PreviewResources }) {
  const limited = usage.memLimitBytes !== null && usage.memPercent !== null;
  return (
    <div className="card-res" aria-label="Resource use">
      <span className="card-res-item" data-tone={loadTone(usage.cpuPercent)}>
        <span className="card-res-label">CPU</span>
        <span className="card-res-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, usage.cpuPercent)}%` }} />
        </span>
        <span className="card-res-value">{Math.round(usage.cpuPercent)}%</span>
      </span>
      <span className="card-res-item" data-tone={loadTone(usage.memPercent)}>
        <span className="card-res-label">Memory</span>
        {limited ? (
          <span className="card-res-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, usage.memPercent ?? 0)}%` }} />
          </span>
        ) : (
          <span />
        )}
        <span className="card-res-value">
          {limited
            ? `${formatBytes(usage.memUsedBytes)} / ${formatBytes(usage.memLimitBytes ?? 0)}`
            : `${formatBytes(usage.memUsedBytes)} used`}
        </span>
      </span>
    </div>
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

/**
 * The link that opens a preview. Sandboxed previews can't read localStorage, so the theme goes in the URL; and they
 * get no referrer, so a preview opened from the Admin page is told so (mayfly_from=admin) and its "Back" link
 * returns there instead of to the board.
 */
export function previewHref(url: string | null | undefined, options: { from?: "admin" } = {}) {
  if (!url) return undefined;
  const path = previewPath(url);
  try {
    const theme =
      typeof document !== "undefined" &&
      (document.documentElement.dataset.theme === "dark" || document.documentElement.dataset.theme === "light")
        ? document.documentElement.dataset.theme
        : null;
    if (!theme && !options.from) return path;
    const next = new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (theme) next.searchParams.set("mayfly_theme", theme);
    if (options.from) next.searchParams.set("mayfly_from", options.from);
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
          <dt>If previews never slept</dt>
          <dd>{formatEstMoney(alwaysTotal, currency)}</dd>
        </div>
        <div>
          <dt>With Mayfly (estimate)</dt>
          <dd>{formatEstMoney(mayflyTotal, currency)}</dd>
        </div>
      </dl>
      <figcaption className="cost-chart-legend">
        <span>
          <i className="cost-swatch cost-swatch-always" aria-hidden="true" /> If previews never slept
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

export type BoardFilter = "all" | "awake" | "asleep" | "building" | "expiring";

export const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

export function matchesBoardFilter(env: Environment, filter: BoardFilter, now: number, demoKey: string | null) {
  if (filter === "all") return true;
  if (filter === "awake") return env.sleep === "awake" || env.sleep === "waking";
  if (filter === "asleep") return env.sleep === "asleep";
  if (filter === "building") return env.status === "provisioning" || env.status === "updating";
  if (filter === "expiring") {
    if (demoKey && demoKey === `${env.repository}#${env.prNumber}`) return false;
    if (env.keptByLabel || !env.expiresAt) return false;
    const left = Date.parse(env.expiresAt) - now;
    return Number.isFinite(left) && left > 0 && left <= EXPIRING_SOON_MS;
  }
  return true;
}

/** "Opened by @login. " at the start of a card's facts, or nothing when the preview has no author. */
export function OpenedBy({ env, onPick }: { env: Environment; onPick?: (login: string) => void }) {
  const login = env.author?.trim();
  if (!login) return null;
  return (
    <>
      Opened by{" "}
      {onPick ? (
        <button
          type="button"
          className="author-link"
          title={`Show only previews opened by @${login}`}
          onClick={() => onPick(login.toLowerCase())}
        >
          @{login}
        </button>
      ) : (
        <span className="author-name">@{login}</span>
      )}
      .{" "}
    </>
  );
}

/** GitHub login of whoever opened the pull request, lower-cased, or null (simulator previews have none). */
export function authorOf(env: Environment) {
  const login = env.author?.trim().toLowerCase();
  return login ? login : null;
}

/** Only previews whose pull request this person opened. null shows everyone's. */
export function matchesBoardAuthor(env: Environment, author: string | null) {
  return !author || authorOf(env) === author.toLowerCase();
}

export function matchesBoardSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // "@madhu" searches people only; "madhu" matches people as well as repos and branches.
  if (q.startsWith("@")) {
    const login = q.slice(1);
    return !login || (authorOf(env) ?? "").includes(login);
  }
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber).includes(q) ||
    env.sha.toLowerCase().includes(q) ||
    (authorOf(env) ?? "").includes(q)
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
      return "started building";
    case "built":
      return "finished building";
    case "ready":
      return "is ready to view";
    case "updated":
      return "got a new commit";
    case "keep_awake":
      return "kept awake";
    case "keep_awake_off":
      return "allowed to sleep again";
    case "slept":
      return "fell asleep";
    case "woke":
      return count > 1 ? "woke up" : "woke up for a visitor";
    case "extended":
      return "extended";
    case "failed":
      return "failed to build";
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

