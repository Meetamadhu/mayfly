"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BarChart, ChartLegend, type ChartSeries } from "@/components/charts";
import { StateGlyph } from "@/components/previews-view";
import {
  ACTIVITY_TABS,
  activityEvents,
  activityKind,
  activityTone,
  dayHeading,
  describeRow,
  groupBursts,
  hoursPerDay,
  rowTime,
  todayCounts,
  type ActivityRow,
  type ActivityTab,
} from "@/lib/activity";
import { PreviewDetails } from "@/components/preview-details";
import { usualBuildMs } from "@/lib/preview-details";
import type { Environment } from "@/lib/types";
import { usePreviewActions, usePreviewPanel } from "@/lib/use-preview-actions";
import { useOverview } from "@/lib/use-overview";

function matchesSearch(env: Environment, query: string) {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!q) return true;
  return (
    env.repository.toLowerCase().includes(q) ||
    env.branch.toLowerCase().includes(q) ||
    String(env.prNumber) === q ||
    env.sha.toLowerCase().startsWith(q) ||
    (env.title ?? "").toLowerCase().includes(q) ||
    (env.author ?? "").toLowerCase().includes(q)
  );
}

/** Rows shown at first; "Show older" adds this many more. */
const PAGE_ROWS = 25;

const HOURS_SERIES: ChartSeries[] = [
  { key: "awake", label: "Awake", tone: "awake" },
  { key: "asleep", label: "Asleep", tone: "asleep" },
];

function formatHoursValue(value: number) {
  if (value <= 0) return "0 h";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} h`;
}

export function ActivityPage() {
  const { overview, loadError, now, reload } = useOverview();
  const { signedIn, busy, error, run } = usePreviewActions(reload);
  const panel = usePreviewPanel();
  const [tab, setTab] = useState<ActivityTab>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_ROWS);

  const config = overview?.config;
  const demoKey = config?.demo ?? null;
  const isDemo = (env: Environment) => `${env.repository}#${env.prNumber}` === demoKey;
  const all = overview ? activityEvents(overview.environments) : [];
  const shown = all.filter((event) => matchesSearch(event.env, query) && (tab === "all" || activityKind(event.type) === tab));
  const allRows = groupBursts(shown);
  const rows = allRows.slice(0, limit);

  const groups: { heading: string; rows: ActivityRow[] }[] = [];
  for (const row of rows) {
    const heading = dayHeading(row.at, now);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }

  const counts = todayCounts(all, now);
  const tabCounts: Partial<Record<ActivityTab, number>> = {};
  for (const event of all) {
    if (!matchesSearch(event.env, query)) continue;
    const kind = activityKind(event.type);
    tabCounts[kind] = (tabCounts[kind] ?? 0) + 1;
  }
  const days = hoursPerDay(overview?.usage?.days, now, 7);
  const owners = [...new Set((overview?.environments ?? []).filter((env) => !isDemo(env)).map((env) => env.repository.split("/")[0]))];
  const livePreviews = (overview?.environments ?? []).filter((env) => env.status !== "destroyed").length;
  const panelEnv = panel.openId ? (overview?.environments.find((env) => env.id === panel.openId) ?? null) : null;
  const describeOptions = { demoKey, fallbackSleepSeconds: config?.sleepSeconds ?? 1800 };

  const today: { id: string; tone: string; label: string; value: number }[] = [
    { id: "build", tone: "building", label: "Builds", value: counts.build },
    { id: "wake", tone: "awake", label: "Wakes", value: counts.wake },
    { id: "nap", tone: "asleep", label: "Naps", value: counts.nap },
    { id: "removed", tone: "failed", label: "Removed", value: counts.removed },
  ];

  return (
    <AppShell
      active="activity"
      githubConnected={Boolean(config?.githubConnected)}
      crumb={owners.length === 1 ? owners[0] : undefined}
      previewCount={overview ? livePreviews : undefined}
      search={{ value: query, onChange: setQuery, placeholder: "Search repo, branch or person" }}
    >
      <header className="pv-head">
        <div className="pv-head-text">
          <h1 className="title-in-header">Activity</h1>
          <p className="pv-lede">Builds, wake-ups, naps and clean-ups across your repos.</p>
        </div>
      </header>

      <div className="pv-tabs" role="tablist" aria-label="Show activity">
        {ACTIVITY_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className="pv-tab"
            onClick={() => {
              setTab(item.id);
              setLimit(PAGE_ROWS);
            }}
          >
            {item.label}
            {item.id !== "all" && tabCounts[item.id] ? <span className="pv-tab-count">{tabCounts[item.id]}</span> : null}
          </button>
        ))}
      </div>

      <div className="act-layout">
        <section className="act-feed" aria-label="Activity log">
          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="act-empty">Loading activity…</p> : null}
          {overview && rows.length === 0 ? (
            <p className="act-empty">
              {query || tab !== "all" ? "Nothing here matches. Try another tab or clear the search." : "Nothing has happened yet. Open a pull request to get a preview."}
            </p>
          ) : null}

          {groups.map((group) => (
            <section key={group.heading} className="act-day" aria-label={group.heading}>
              <h2 className="act-day-title">{group.heading}</h2>
              <ol className="act-list">
                {group.rows.map((row, index) => {
                  const single = row.envs.length === 1 ? row.envs[0] : null;
                  const text = describeRow(row, describeOptions);
                  return (
                    <li key={`${row.at}-${row.type}-${index}`} className="act-row">
                      <span className="act-icon" data-tone={activityTone(row.type)} aria-hidden="true">
                        <StateGlyph tone={activityTone(row.type)} />
                      </span>
                      <span className="act-text">
                        <span className="act-title">
                          {text.before}
                          {single ? (
                            <button
                              type="button"
                              className="act-subject"
                              onClick={() => panel.open(single.id)}
                              aria-label={`${text.subject}: show its history`}
                            >
                              {text.subject}
                            </button>
                          ) : (
                            text.subject
                          )}
                          {text.after}
                        </span>
                        <span className="act-sub">{text.sub}</span>
                      </span>
                      <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
                        {rowTime(row.at, now)}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}

          {allRows.length > rows.length ? (
            <button type="button" className="pv-btn act-more" onClick={() => setLimit((value) => value + PAGE_ROWS)}>
              Show older ({allRows.length - rows.length} more)
            </button>
          ) : null}

          {overview && rows.length > 0 ? (
            <p className="act-note">
              Mayfly keeps the last 50 events for each preview, even after it&apos;s removed. Click a PR number to see
              its details and whole history.
            </p>
          ) : null}
        </section>

        <aside className="act-side" aria-label="Summary">
          <section className="act-card" aria-labelledby="act-hours-title">
            <div className="act-card-head">
              <div>
                <h2 id="act-hours-title">Preview hours per day</h2>
                <p>Awake vs asleep, last 7 days</p>
              </div>
              <ChartLegend series={HOURS_SERIES} />
            </div>
            <BarChart
              stacked
              minTop={4}
              caption="Preview hours per day, awake and asleep, last 7 days"
              series={HOURS_SERIES}
              columns={days.map((day) => ({
                label: day.label,
                title: new Date(`${day.key}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }),
                values: { awake: day.awake, asleep: day.asleep },
              }))}
              format={formatHoursValue}
              axisFormat={(value) => String(Math.round(value * 10) / 10)}
            />
          </section>

          <section className="act-card" aria-labelledby="act-today-title">
            <h2 id="act-today-title" className="act-card-title">
              Today so far
            </h2>
            <ul className="act-today">
              {today.map((item) => (
                <li key={item.id}>
                  <span className="act-icon" data-tone={item.tone} aria-hidden="true">
                    <StateGlyph tone={item.tone} />
                  </span>
                  <span>{item.label}</span>
                  <strong>{overview ? item.value : "…"}</strong>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      <PreviewDetails
        env={panelEnv}
        demo={panelEnv ? isDemo(panelEnv) : false}
        now={now}
        signedIn={signedIn}
        busy={busy}
        error={error}
        currency={overview?.currency ?? overview?.config.currency ?? "$"}
        costPerHour={overview?.costPerHour ?? 0.05}
        fallbackSleepSeconds={overview?.config.sleepSeconds ?? 1800}
        usualBuildMs={usualBuildMs(overview?.environments ?? [])}
        backLabel="Activity"
        onAction={run}
        onClose={panel.close}
      />
    </AppShell>
  );
}
