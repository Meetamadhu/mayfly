"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BuildLog,
  cardState,
  estimatedCost,
  FailureSummary,
  formatAgo,
  formatEstMoney,
  matchesBoardFilter,
  previewHref,
  statePillLabel,
  type BoardFilter,
  type CardState,
} from "@/components/board-parts";
import type { PreviewResources } from "@/lib/resources";
import type { Environment, Overview } from "@/lib/types";

/**
 * The Previews page as designed: four number cards, tabs, and a table of pull requests with one main action
 * each (Open, Wake, Logs) and the rest in a "…" menu. On phones the table becomes a list of rows.
 */

export type PreviewSort = "visit" | "newest" | "expiring";
export const SORT_LABELS: Record<PreviewSort, string> = {
  visit: "Last visit",
  newest: "Newest",
  expiring: "Ends soonest",
};

export function sortPreviews(list: Environment[], sort: PreviewSort) {
  const time = (iso: string | null | undefined) => {
    const value = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(value) ? value : 0;
  };
  return [...list].sort((a, b) => {
    if (sort === "newest") return time(b.createdAt) - time(a.createdAt);
    if (sort === "expiring") return (time(a.expiresAt) || Infinity) - (time(b.expiresAt) || Infinity);
    return time(b.lastActiveAt) - time(a.lastActiveAt);
  });
}

// ── Number cards ────────────────────────────────────────────────────────────────────────────────────────────────

function minutes(ms: number) {
  return Math.max(1, Math.round(ms / 60_000));
}

/** "sleeps in 6–18 min" for the awake previews, from each one's last visit and its own sleep time. */
export function sleepsInRange(envs: Environment[], fallbackSleepSeconds: number, now: number) {
  const left = envs
    .filter((env) => cardState(env) === "running" && !(env.keepAwakeUntil && Date.parse(env.keepAwakeUntil) > now))
    .map((env) => Date.parse(env.lastActiveAt) + (env.sleepSeconds ?? fallbackSleepSeconds) * 1000 - now)
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (left.length === 0) return null;
  const low = minutes(Math.min(...left));
  const high = minutes(Math.max(...left));
  return low === high ? `sleeps in ${low} min` : `sleeps in ${low}–${high} min`;
}

/** "usually 14 s" from the previews' last build times. */
export function usualBuild(envs: Environment[]) {
  const times = envs.map((env) => env.buildMs).filter((ms): ms is number => typeof ms === "number" && ms > 0);
  if (times.length === 0) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const seconds = Math.max(1, Math.round(median / 1000));
  return seconds >= 120 ? `usually ${Math.round(seconds / 60)} min` : `usually ${seconds} s`;
}

export function PreviewStats({ overview, current, now }: { overview: Overview | null; current: Environment[]; now: number }) {
  const currency = overview?.currency ?? overview?.config.currency ?? "$";
  const awake = current.filter((env) => cardState(env) === "running").length;
  const asleep = current.filter((env) => cardState(env) === "sleeping").length;
  const building = current.filter((env) => cardState(env) === "building").length;
  const usage = overview?.usage;
  const total = (usage?.awakeSeconds ?? 0) + (usage?.asleepSeconds ?? 0);
  const percent = total > 0 ? Math.round(((usage?.asleepSeconds ?? 0) / total) * 100) : null;
  const saved = overview?.savedEstimate ?? 0;

  const cards: { id: string; icon: "running" | "sleeping" | "building" | "savings"; label: string; value: string; hint: string | null }[] = [
    {
      id: "awake",
      icon: "running",
      label: "Awake",
      value: String(awake),
      hint: overview ? sleepsInRange(current, overview.config.sleepSeconds, now) : null,
    },
    { id: "asleep", icon: "sleeping", label: "Asleep", value: String(asleep), hint: asleep > 0 ? "wake on next visit" : null },
    { id: "building", icon: "building", label: "Building", value: String(building), hint: usualBuild(current) },
    {
      id: "saved",
      icon: "savings",
      label: "Saved this month",
      value: overview ? formatEstMoney(saved, currency) : "…",
      hint: percent !== null && percent > 0 ? `${percent}% vs always on` : null,
    },
  ];

  return (
    <section className="pv-stats" aria-label="Summary">
      {cards.map((card) => (
        <div key={card.id} className="pv-stat" data-tone={card.id}>
          <div className="pv-stat-head">
            <span className="pv-stat-icon" aria-hidden="true">
              <StateGlyph tone={card.id} />
            </span>
            <span className="pv-stat-label">{card.label}</span>
          </div>
          <div className="pv-stat-foot">
            <strong className="pv-stat-value">{overview ? card.value : "…"}</strong>
            {card.hint ? <span className="pv-stat-hint">{card.hint}</span> : null}
          </div>
        </div>
      ))}
    </section>
  );
}

/** The four state symbols from the design: a ring (awake), a moon (asleep), a dashed ring (building), an arrow (saved). */
export function StateGlyph({ tone }: { tone: string }) {
  const common = { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": true as const };
  if (tone === "asleep")
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor" />
      </svg>
    );
  if (tone === "building")
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <circle cx="12" cy="12" r="7" strokeDasharray="5.5 3.5" />
      </svg>
    );
  if (tone === "saved")
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" />
      </svg>
    );
  if (tone === "time")
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  if (tone === "failed" || tone === "removed")
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M7 7l10 10M17 7 7 17" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────────────────────────────────────────

const AVATAR_TONES = ["blue", "orange", "violet", "teal", "pink", "amber"] as const;

/** A repository's letter and colour: the same repository always gets the same ones. */
export function repoAvatar(repository: string) {
  const name = repository.split("/").pop() ?? repository;
  let hash = 0;
  for (const char of repository) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter: (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase(), tone: AVATAR_TONES[hash % AVATAR_TONES.length] };
}

function expiresSoon(env: Environment, now: number, demo: boolean) {
  if (!matchesBoardFilter(env, "expiring", now, demo ? `${env.repository}#${env.prNumber}` : null)) return null;
  const left = Date.parse(env.expiresAt) - now;
  if (left < 60 * 60 * 1000) return `Ends in ${Math.max(1, Math.round(left / 60_000))} min`;
  return `Ends in ${Math.round(left / 3_600_000)} h`;
}

type RowProps = {
  env: Environment;
  now: number;
  demo: boolean;
  signedIn: boolean;
  busy: boolean;
  currency: string;
  costPerHour: number;
  resources?: PreviewResources;
  measured: boolean;
  onAdminAction: (env: Environment, action: "sleep" | "extend" | "destroy") => void;
  onShowHistory: (env: Environment) => void;
  onPickAuthor: (login: string) => void;
};

function RowMenu({ env, signedIn, busy, state, onAdminAction, onShowHistory }: Pick<RowProps, "env" | "signedIn" | "busy" | "onAdminAction" | "onShowHistory"> & { state: CardState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="pv-menu" ref={ref}>
      <button
        type="button"
        className="pv-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for PR #${env.prNumber}`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </svg>
      </button>
      {open ? (
        <div className="pv-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={act(() => onShowHistory(env))}>
            History
          </button>
          {signedIn ? (
            <>
              <button type="button" role="menuitem" disabled={busy || state !== "running"} onClick={act(() => onAdminAction(env, "sleep"))}>
                Put to sleep
              </button>
              <button type="button" role="menuitem" disabled={busy} onClick={act(() => onAdminAction(env, "extend"))}>
                Extend by 4 h
              </button>
              <button type="button" role="menuitem" className="danger" disabled={busy} onClick={act(() => onAdminAction(env, "destroy"))}>
                Remove
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewRow(props: RowProps) {
  const { env, now, demo, signedIn, busy, currency, costPerHour, resources, measured, onShowHistory, onPickAuthor } = props;
  const [showLog, setShowLog] = useState(false);
  const state = cardState(env);
  const avatar = repoAvatar(env.repository);
  const href = previewHref(env.url);
  const ends = expiresSoon(env, now, demo);
  const cost = env.usage ? estimatedCost(env.usage.awakeSeconds, costPerHour) : null;
  const title = env.title?.trim() || `PR #${env.prNumber}`;

  let action: ReactNode;
  if (state === "failed") {
    action = signedIn ? (
      <button type="button" className="pv-act pv-act-logs" aria-expanded={showLog} onClick={() => setShowLog((value) => !value)}>
        {showLog ? "Hide logs" : "Logs"}
      </button>
    ) : (
      <a className="pv-act pv-act-logs" href="/admin/login">
        Logs
      </a>
    );
  } else if (state === "building" || state === "destroying") {
    action = (
      <button type="button" className="pv-act pv-act-logs" onClick={() => onShowHistory(env)}>
        {state === "building" ? "Progress" : "Removing…"}
      </button>
    );
  } else if (state === "sleeping") {
    action = href ? (
      <a className="pv-act pv-act-wake" href={href}>
        Wake
      </a>
    ) : (
      <button type="button" className="pv-act pv-act-wake" disabled>
        Wake
      </button>
    );
  } else {
    action = href ? (
      <a className="pv-act pv-act-open" href={href}>
        Open
      </a>
    ) : (
      <button type="button" className="pv-act pv-act-open" disabled>
        Open
      </button>
    );
  }

  return (
    <>
      <tr className="pv-row" data-state={state}>
        <td className="pv-cell-pr">
          <div className="pv-pr">
          <span className="pv-avatar" data-tone={avatar.tone} title={env.repository} aria-hidden="true">
            {avatar.letter}
          </span>
          <span className="pv-pr-text">
            <button type="button" className="pv-title" onClick={() => onShowHistory(env)} title="Show history">
              {title}
            </button>
            <span className="pv-sub">
              {env.repository} #{env.prNumber}
              {env.author ? (
                <>
                  {" · "}
                  <button type="button" className="pv-author" onClick={() => onPickAuthor(env.author!.toLowerCase())} title={`Only @${env.author}'s previews`}>
                    @{env.author}
                  </button>
                </>
              ) : null}
            </span>
          </span>
          </div>
        </td>
        <td className="pv-cell-branch">
          <code className="pv-branch" title={env.branch}>
            {env.branch}
          </code>
        </td>
        <td className="pv-cell-status">
          <span className="pv-pill" data-state={state}>
            <StatusIcon state={state} />
            {statePillLabel(state)}
          </span>
          {state === "running" && resources ? (
            <span className="pv-usage">
              CPU {Math.round(resources.cpuPercent)}% ·{" "}
              {resources.memLimitBytes ? `${Math.round(resources.memUsedBytes / 1048576)} / ${Math.round(resources.memLimitBytes / 1048576)} MB` : `${Math.round(resources.memUsedBytes / 1048576)} MB`}
            </span>
          ) : state === "running" && measured ? (
            <span className="pv-usage">Measuring…</span>
          ) : state === "sleeping" && measured ? (
            <span className="pv-usage">No CPU or memory</span>
          ) : null}
        </td>
        <td className="pv-cell-visit">
          <span>{formatAgo(env.lastActiveAt, now)}</span>
          {ends ? <span className="pv-ends">{ends}</span> : null}
        </td>
        <td className="pv-cell-cost">{cost === null ? "—" : formatEstMoney(cost, currency)}</td>
        <td className="pv-cell-action">
          {action}
          <RowMenu env={env} signedIn={signedIn} busy={busy} state={state} onAdminAction={props.onAdminAction} onShowHistory={onShowHistory} />
        </td>
      </tr>
      {state === "failed" && env.error ? (
        <tr className="pv-detail-row">
          <td colSpan={6}>
            <FailureSummary error={env.error} signedIn={signedIn} />
            {showLog && signedIn ? <BuildLog error={env.error} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StatusIcon({ state }: { state: CardState }) {
  if (state === "sleeping")
    return (
      <svg className="pv-pill-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor" />
      </svg>
    );
  return <span className="pv-pill-dot" aria-hidden="true" />;
}

export function PreviewsTable(
  props: Omit<RowProps, "env" | "demo" | "resources"> & {
    previews: Environment[];
    demoKey: string | null;
    resourcesFor: (env: Environment) => PreviewResources | undefined;
  },
) {
  const { previews, demoKey, resourcesFor, ...rest } = props;
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead>
          <tr>
            <th scope="col">Pull request</th>
            <th scope="col">Branch</th>
            <th scope="col">Status</th>
            <th scope="col">Last visit</th>
            <th scope="col">Cost</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {previews.map((env) => (
            <PreviewRow
              key={env.id}
              env={env}
              demo={demoKey === `${env.repository}#${env.prNumber}`}
              resources={resourcesFor(env)}
              {...rest}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tabs, Filters, Sort ─────────────────────────────────────────────────────────────────────────────────────────

export const TABS: [BoardFilter, string][] = [
  ["all", "All"],
  ["awake", "Awake"],
  ["asleep", "Asleep"],
  ["building", "Building"],
  ["expiring", "Ending soon"],
];

export function PreviewTabs({ value, counts, onChange }: { value: BoardFilter; counts: Partial<Record<BoardFilter, number>>; onChange: (next: BoardFilter) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  // On a narrow screen the tabs scroll sideways: fade the right edge while more are hidden there.
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const update = () => setAtEnd(list.scrollLeft + list.clientWidth >= list.scrollWidth - 4);
    update();
    list.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      list.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="pv-tabs" role="tablist" aria-label="Show previews" ref={ref} data-at-end={atEnd ? "1" : undefined}>
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className="pv-tab"
          onClick={(event) => {
            onChange(id);
            event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
          }}
        >
          {label}
          {counts[id] ? <span className="pv-tab-count">{counts[id]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A small popover anchored to a button, closed by Escape or a click outside. */
export function Popover({ label, children, align = "end" }: { label: ReactNode; children: (close: () => void) => ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="pv-pop" ref={ref}>
      <button type="button" className="pv-pop-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
      </button>
      {open ? (
        <div className="pv-pop-panel" data-align={align}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
