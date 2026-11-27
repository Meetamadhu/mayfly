"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import type { HealthReport, OpsMetrics } from "@/lib/health";
import type { ServerResources } from "@/lib/resources";
import { formatBytes } from "@/lib/use-resources";

type OpsView = {
  health: HealthReport;
  metrics: OpsMetrics;
  resources: ServerResources | null;
  scaling: { note: string; instance: string; repositories: string[] | null };
};

function uptime(startedAt: string, now: number) {
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * Admin operations: is this host healthy, what is it running, how to scale out, and a download of the audit log.
 */
export function OpsPage() {
  const [view, setView] = useState<OpsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [includeDestroyed, setIncludeDestroyed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ops", { credentials: "include", cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/admin/login?next=/ops");
        return;
      }
      const body = (await response.json().catch(() => ({}))) as OpsView & { error?: string; ok?: boolean };
      if (!response.ok || !body.ok) throw new Error(body.error || "Couldn't load ops.");
      setView(body);
      setError(null);
      setNow(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't load ops.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const health = view?.health;
  const metrics = view?.metrics;
  const resources = view?.resources;

  return (
    <AppShell active="ops" githubConnected={false}>
      <header className="pv-head">
        <div className="pv-head-text">
          <h1 className="title-in-header">Health &amp; ops</h1>
          <p className="pv-lede">
            {health ? (
              <>
                Instance <strong className="mono">{health.instance}</strong>
                {health.ok ? " is healthy" : " needs attention"} · up {uptime(health.startedAt, now)}.
              </>
            ) : (
              "Checking this host…"
            )}
          </p>
        </div>
        <button type="button" className="pv-btn" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="cost-cards ops-cards" aria-label="Status">
        <div className="cost-hero" data-tone={health?.ok ? "ok" : "bad"}>
          <p className="cost-hero-label">This host</p>
          <strong className="cost-hero-value">{health ? (health.ok ? "OK" : "Degraded") : "…"}</strong>
          <span className="cost-hero-pill">{health?.instance ?? "…"}</span>
        </div>
        <div className="cost-card">
          <strong>{metrics ? metrics.live : "…"}</strong>
          <span className="cost-card-label">Live previews</span>
          <span className="cost-card-sub">
            {metrics ? `${metrics.awake} awake · ${metrics.asleep} asleep · ${metrics.building} building` : "–"}
          </span>
        </div>
        <div className="cost-card">
          <strong>{resources?.cpuPercent == null ? "…" : `${Math.round(resources.cpuPercent)}%`}</strong>
          <span className="cost-card-label">CPU</span>
          <span className="cost-card-sub">{resources ? `of ${resources.cpus} CPUs (${resources.scope})` : "–"}</span>
        </div>
        <div className="cost-card">
          <strong>{resources ? `${Math.round(resources.memPercent)}%` : "…"}</strong>
          <span className="cost-card-label">Memory</span>
          <span className="cost-card-sub">
            {resources ? `${formatBytes(resources.memUsedBytes)} of ${formatBytes(resources.memTotalBytes)}` : "–"}
          </span>
        </div>
      </section>

      <div className="cost-middle">
        <section className="act-card" aria-labelledby="ops-checks-title">
          <div className="act-card-head">
            <div>
              <h2 id="ops-checks-title">Checks</h2>
              <p>What an uptime monitor hits at /api/health.</p>
            </div>
          </div>
          {health ? (
            <ul className="ops-checks">
              {(
                [
                  ["storage", "Saved state"],
                  ["disk", "Disk space"],
                  ["docker", "Docker"],
                  ["reaper", "Clean-up loop"],
                ] as const
              ).map(([key, label]) => {
                const check = health.checks[key];
                return (
                  <li key={key} data-ok={check.ok ? "1" : "0"}>
                    <span className="adm-chip" data-tone={check.ok ? "ok" : "bad"}>
                      {check.ok ? "OK" : "Fail"}
                    </span>
                    <div>
                      <strong>{label}</strong>
                      <p>{check.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="act-empty">Loading…</p>
          )}
        </section>

        <section className="act-card" aria-labelledby="ops-scale-title">
          <div className="act-card-head">
            <div>
              <h2 id="ops-scale-title">More than one server</h2>
              <p>How Mayfly scales today.</p>
            </div>
          </div>
          <p className="ops-scale-note">{view?.scaling.note ?? "…"}</p>
          <dl className="ops-scale-list">
            <div>
              <dt>This instance</dt>
              <dd className="mono">{view?.scaling.instance ?? "…"}</dd>
            </div>
            <div>
              <dt>Repositories it builds</dt>
              <dd>
                {view?.scaling.repositories == null
                  ? "None (process or demo mode)"
                  : view.scaling.repositories.length === 0
                    ? "None listed in PREVIEW_REPOS"
                    : view.scaling.repositories.join(", ")}
              </dd>
            </div>
            <div>
              <dt>Name it</dt>
              <dd>
                Set <code>MAYFLY_INSTANCE</code> in <code>.env.local</code> so each host is easy to tell apart.
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="act-card" aria-labelledby="ops-audit-title">
        <div className="act-card-head">
          <div>
            <h2 id="ops-audit-title">Audit log</h2>
            <p>Every saved lifecycle event on this host&apos;s previews (opened, built, slept, removed, …).</p>
          </div>
        </div>
        <label className="cost-ctrl-check">
          <input type="checkbox" checked={includeDestroyed} onChange={(event) => setIncludeDestroyed(event.target.checked)} />
          Include removed previews
        </label>
        <div className="cost-ctrl-actions">
          <a className="pv-btn pv-btn-primary" href={`/api/ops/audit.csv${includeDestroyed ? "?destroyed=1" : ""}`}>
            Download CSV
          </a>
        </div>
      </section>
    </AppShell>
  );
}
