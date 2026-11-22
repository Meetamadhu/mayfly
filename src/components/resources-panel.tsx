"use client";

import type { Environment } from "@/lib/types";
import { formatBytes, loadTone, useResources } from "@/lib/use-resources";

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const shown = percent === null ? null : Math.round(percent);
  return (
    <div className="res-meter" data-tone={loadTone(percent)}>
      <div className="res-meter-head">
        <span>{label}</span>
        <strong>{shown === null ? "…" : `${shown}%`}</strong>
      </div>
      <div
        className="res-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown ?? undefined}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
      </div>
      <p className="res-detail">{detail}</p>
    </div>
  );
}

/**
 * Admin page: CPU and memory for the server, and the previews using the most memory. Refreshes every 15 seconds.
 */
export function ResourcesPanel({ environments }: { environments: Environment[] }) {
  const view = useResources(15_000);
  const server = view?.server;

  const top = view?.previews
    ? environments
        .filter((env) => env.deploymentId && view.previews?.[env.deploymentId])
        .map((env) => ({ env, usage: view.previews![env.deploymentId!] }))
        .sort((a, b) => b.usage.memUsedBytes - a.usage.memUsedBytes)
        .slice(0, 5)
    : [];

  return (
    <section className="panel config-check" aria-label="Server resources">
      <h2>Server resources</h2>
      <p className="help">
        {server?.scope === "container"
          ? "What Mayfly's own container is allowed to use on this host."
          : "The whole server Mayfly runs on, previews included."}{" "}
        You get an alert if memory stays above {server?.alertPercent ?? 90}% for a few minutes.
      </p>

      {server ? (
        <div className="res-grid">
          <Meter
            label="CPU"
            percent={server.cpuPercent}
            detail={`of ${server.cpus} ${server.cpus === 1 ? "CPU" : "CPUs"}`}
          />
          <Meter
            label="Memory"
            percent={server.memPercent}
            detail={`${formatBytes(server.memUsedBytes)} of ${formatBytes(server.memTotalBytes)}`}
          />
        </div>
      ) : (
        <p className="help">Reading the numbers…</p>
      )}

      <h3 className="res-subhead">Previews using the most memory</h3>
      {view && view.previews === null ? (
        <p className="help">
          Shown when previews run in Docker. Here they&apos;re simulated, so there&apos;s nothing to measure.
        </p>
      ) : top.length === 0 ? (
        <p className="help">No preview is awake right now. Sleeping previews use no CPU or memory.</p>
      ) : (
        <ul className="res-list">
          {top.map(({ env, usage }) => (
            <li key={env.id} data-tone={loadTone(usage.memPercent)}>
              <span className="res-list-name">
                PR #{env.prNumber} <span className="muted">{env.repository}</span>
              </span>
              <span className="res-list-nums">
                CPU {Math.round(usage.cpuPercent)}% · {formatBytes(usage.memUsedBytes)} of{" "}
                {formatBytes(usage.memLimitBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
