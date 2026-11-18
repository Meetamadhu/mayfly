"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LifecycleDrawer, StateIcon, activityIcon, formatAgo } from "@/components/board-parts";
import type { Environment } from "@/lib/types";
import { timelineLabel, timelineNewestFirst } from "@/lib/timeline";
import { useOverview } from "@/lib/use-overview";

type ActivityFilter = "all" | "builds" | "sleep" | "lifetime" | "removed";

const FILTERS: { id: ActivityFilter; label: string; types: Set<string> | null }[] = [
  { id: "all", label: "All", types: null },
  { id: "builds", label: "Builds & new commits", types: new Set(["opened", "build_started", "built", "ready", "updated", "failed"]) },
  { id: "sleep", label: "Sleep & wake", types: new Set(["slept", "woke"]) },
  { id: "lifetime", label: "Time extended", types: new Set(["extended", "keep_awake", "keep_awake_off"]) },
  { id: "removed", label: "Removed", types: new Set(["destroyed"]) },
];

const BURST_MS = 2 * 60 * 1000;

type Row = {
  at: string;
  type: string;
  label: string;
  envs: Environment[];
};

function dayHeading(iso: string, now: number) {
  const day = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(day, today)) return "Today";
  if (same(day, yesterday)) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function matchesSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber) === q ||
    env.sha.toLowerCase().startsWith(q)
  );
}

/** "PR #4 built in 6 s", "PR #1 woken by a visit (1 s)", "PR #9 removed (PR closed)". */
function verb(row: Row) {
  if (row.type === "opened") return "opened";
  if (row.type === "ready") return "ready";
  if (row.type === "slept") return "slept";
  return row.label.charAt(0).toLowerCase() + row.label.slice(1);
}

export function ActivityPage() {
  const { overview, loadError, now } = useOverview();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [query, setQuery] = useState("");
  const [lifecycleId, setLifecycleId] = useState<string | null>(null);

  const config = overview?.config;
  const demoKey = config?.demo ?? null;
  const isDemo = (env: Environment) => `${env.repository}#${env.prNumber}` === demoKey;
  const repos = new Set((overview?.environments ?? []).filter((env) => !isDemo(env)).map((env) => env.repository));
  const showRepo = repos.size > 1;
  const types = FILTERS.find((item) => item.id === filter)?.types ?? null;

  const raw: { at: string; type: string; label: string; env: Environment }[] = [];
  for (const env of overview?.environments ?? []) {
    if (!matchesSearch(env, query)) continue;
    // Newest first per preview, so events recorded at the same moment (built, then ready) keep their order.
    for (const event of timelineNewestFirst(env.events)) {
      if (types && !types.has(event.type)) continue;
      raw.push({ at: event.at, type: event.type, label: timelineLabel(event), env });
    }
  }
  raw.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  // Several previews sleeping or waking together (e.g. after a restart) read as one line.
  const rows: Row[] = [];
  for (let i = 0; i < raw.length; ) {
    const first = raw[i];
    let j = i + 1;
    if (first.type === "slept" || first.type === "woke") {
      while (j < raw.length && raw[j].type === first.type && Date.parse(first.at) - Date.parse(raw[j].at) <= BURST_MS) {
        j += 1;
      }
    }
    rows.push({ at: first.at, type: first.type, label: first.label, envs: raw.slice(i, j).map((item) => item.env) });
    i = j;
  }

  const groups: { heading: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const heading = dayHeading(row.at, now);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }

  const todayCount = rows.filter((row) => dayHeading(row.at, now) === "Today").length;
  const builds = raw.filter((item) => item.type === "built").length;
  const wakes = raw.filter((item) => item.type === "woke").length;
  const lifecycleEnv = lifecycleId ? (overview?.environments.find((env) => env.id === lifecycleId) ?? null) : null;

  function subject(env: Environment) {
    return isDemo(env) ? "Demo" : `PR #${env.prNumber}`;
  }

  return (
    <AppShell
      active="activity"
      githubConnected={Boolean(config?.githubConnected)}
      search={{ value: query, onChange: setQuery, placeholder: "Filter by PR number, repo, branch or commit" }}
    >
      <section className="board-welcome">
        <div>
          <h1>Activity</h1>
          <p className="lede">Everything that happened to your previews: builds, naps, wake-ups and clean-ups.</p>
        </div>
      </section>

      <dl className="stats board-stats page-stats">
        <div data-stat="live">
          <dt>Things that happened today</dt>
          <dd>{overview ? todayCount : "–"}</dd>
        </div>
        <div data-stat="building">
          <dt>Builds today</dt>
          <dd>{overview ? builds : "–"}</dd>
        </div>
        <div data-stat="awake">
          <dt>Wake-ups today</dt>
          <dd>{overview ? wakes : "–"}</dd>
        </div>
      </dl>

      <section className="live-column page-panel" aria-label="Activity log">
        <div className="board-filters">
          <div className="board-filter-pills" role="group" aria-label="Filter activity">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="board-filter-pill"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {loadError ? <p className="error" role="alert">{loadError}</p> : null}
        {!overview && !loadError ? <p className="empty">Loading activity…</p> : null}
        {overview && rows.length === 0 ? (
          <p className="empty">{query || filter !== "all" ? "No activity matches this filter." : "No activity yet."}</p>
        ) : null}

        {groups.map((group) => (
          <section key={group.heading} className="activity-day" aria-label={group.heading}>
            <h2 className="activity-day-title">{group.heading}</h2>
            <ol className="board-activity-list activity-log">
              {group.rows.map((row, index) => {
                const single = row.envs.length === 1 ? row.envs[0] : null;
                return (
                  <li key={`${row.at}-${row.type}-${index}`} data-tone={activityIcon(row.type)}>
                    <span className="board-activity-icon" aria-hidden="true">
                      <StateIcon name={activityIcon(row.type)} />
                    </span>
                    <span className="board-activity-text">
                      {single ? (
                        <button type="button" className="activity-subject" onClick={() => setLifecycleId(single.id)}>
                          {subject(single)}
                        </button>
                      ) : (
                        <strong>{row.envs.length} previews</strong>
                      )}{" "}
                      {single ? verb(row) : row.type === "slept" ? "slept" : "woke"}
                      <span className="board-activity-repo">
                        {single
                          ? ` · ${showRepo && !isDemo(single) ? `${single.repository} · ` : ""}${isDemo(single) ? "demo" : single.branch}`
                          : ` · ${row.envs.map(subject).join(", ")}`}
                      </span>
                    </span>
                    <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
                      {clock(row.at)} · {formatAgo(row.at, now)}
                    </time>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}

        <p className="help activity-note">
          Mayfly remembers the last 50 things that happened to each preview, even after it&apos;s removed. Click a pull
          request to see its whole history.
        </p>
      </section>

      <LifecycleDrawer
        env={lifecycleEnv}
        demo={lifecycleEnv ? isDemo(lifecycleEnv) : false}
        onClose={() => setLifecycleId(null)}
      />
    </AppShell>
  );
}
