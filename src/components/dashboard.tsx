"use client";

import { useCallback, useEffect, useState } from "react";
import type { Environment, EnvironmentStatus, Overview } from "@/lib/types";

const TRANSITIONAL = new Set<EnvironmentStatus>(["provisioning", "updating", "destroying"]);

function randomSha() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatDelta(iso: string) {
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) return iso;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return delta >= 0 ? "now" : "just now";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const text = hours > 0 ? `${hours}h ${rest}m` : `${minutes}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

async function readJson(response: Response) {
  const body = (await response.json()) as { error?: string; ok?: boolean };
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState("acme/web");
  const [prNumber, setPrNumber] = useState("42");
  const [branch, setBranch] = useState("feat/preview-lifetime");
  const [sha, setSha] = useState("a1b2c3d4e5f67890");
  const [ttlMinutes, setTtlMinutes] = useState("480");

  const reload = useCallback(async () => {
    const response = await fetch("/api/environments", { cache: "no-store" });
    const body = (await response.json()) as Overview & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load environments.");
    setOverview(body);
    setLoadError(null);
    return body;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function tick() {
      try {
        const body = await reload();
        if (cancelled) return;
        if (body.environments.some((env) => TRANSITIONAL.has(env.status))) {
          timer = window.setTimeout(() => void tick(), 500);
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

  async function send(
    action: "opened" | "synchronize" | "closed" | "reopened",
    overrides?: { sha?: string; merged?: boolean },
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          repository,
          prNumber: Number(prNumber),
          sha: overrides?.sha ?? sha,
          branch,
          merged: overrides?.merged ?? false,
          ttlMinutes: Number(ttlMinutes),
        }),
      });
      const body = (await readJson(response)) as { environment?: Environment; action?: string };
      setNotice(null);
      setFocusId(body.environment?.id ?? null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "destroy" | "idle") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/environments/${id}?action=${action}`, { method: "POST" });
      const body = (await readJson(response)) as { environment?: Environment };
      const env = body.environment;
      setFocusId(env?.id ?? null);
      setNotice(action === "idle" ? "Marked idle. Run the reaper to delete it." : null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runReaper() {
    const started = Date.now();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFocusId(null);
    try {
      const response = await fetch("/api/reaper", { method: "POST" });
      const body = (await readJson(response)) as { destroyed: Environment[]; failed: { error: string }[] };
      const fresh = await reload();
      const recent = fresh.environments.filter(
        (env) => env.destroyedAt && Date.parse(env.destroyedAt) >= started - 2_000,
      );
      if (body.failed.length > 0) {
        setError(body.failed.map((item) => item.error).join(" "));
      } else if (body.destroyed.length > 0) {
        const reasons = body.destroyed.map((env) => `${env.repository}#${env.prNumber} (${env.destroyReason})`).join(", ");
        setNotice(`Destroyed ${body.destroyed.length}: ${reasons}.`);
      } else if (recent.length > 0) {
        const reasons = recent.map((env) => `${env.repository}#${env.prNumber} (${env.destroyReason})`).join(", ");
        setNotice(`Destroyed ${recent.length}: ${reasons}.`);
      } else {
        setNotice("Nothing was due. Live previews are still inside their TTL and idle window.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reaper failed.");
    } finally {
      setBusy(false);
    }
  }

  const config = overview?.config;
  const focused = overview?.environments.find((env) => env.id === focusId) ?? null;
  const statusLine =
    notice ??
    (focused
      ? focused.status === "ready" && focused.url
        ? focused.url
        : `${focused.repository}#${focused.prNumber} is ${focused.status}${focused.destroyReason ? ` (${focused.destroyReason})` : ""}.`
      : null);

  return (
    <main className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">Preview control</p>
          <h1>Ephemeral environments</h1>
          <p className="lede">
            A pull request gets a test deployment. Close it, leave it idle, or let the clock run out, and the
            deployment is deleted so staging stops billing.
          </p>
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Live</dt>
          <dd>
            {overview?.summary.live ?? "–"}
            <span>/{config?.maxConcurrent ?? "–"}</span>
          </dd>
        </div>
        <div>
          <dt>Destroyed</dt>
          <dd>{overview?.summary.destroyed ?? "–"}</dd>
        </div>
        <div>
          <dt>Idle window</dt>
          <dd>
            {config?.idleHours ?? "–"}
            <span>h</span>
          </dd>
        </div>
        <div>
          <dt>Max lifetime</dt>
          <dd>
            {config?.ttlHours ?? "–"}
            <span>h</span>
          </dd>
        </div>
      </dl>

      <div className="layout">
        <section className="panel">
          <h2>Pull request</h2>
          <p className="help">
            This talks to the orchestrator directly. GitHub can send the same actions to <span className="mono">/api/webhooks/github</span>.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send("opened");
            }}
          >
            <label>
              Repository
              <input value={repository} onChange={(event) => setRepository(event.target.value)} required />
            </label>
            <label>
              Pull request
              <input
                value={prNumber}
                onChange={(event) => setPrNumber(event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              Branch
              <input value={branch} onChange={(event) => setBranch(event.target.value)} required />
            </label>
            <label>
              Commit
              <input value={sha} onChange={(event) => setSha(event.target.value)} className="mono" required />
            </label>
            <label>
              TTL minutes
              <input
                value={ttlMinutes}
                onChange={(event) => setTtlMinutes(event.target.value)}
                inputMode="numeric"
                min={0}
                max={10080}
                required
              />
            </label>
            <p className="help">Use 0 to expire as soon as the preview is ready, then run the reaper.</p>
            <div className="actions">
              <button type="submit" disabled={busy}>Open</button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  const next = randomSha();
                  setSha(next);
                  void send("synchronize", { sha: next });
                }}
              >
                Push commit
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void send("closed")}>
                Close
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void send("closed", { merged: true })}
              >
                Merge
              </button>
            </div>
          </form>
          {statusLine ? (
            <p className="notice" role="status">
              {statusLine.startsWith("http") ? (
                <a href={statusLine} target="_blank" rel="noreferrer">{statusLine}</a>
              ) : (
                statusLine
              )}
            </p>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
        </section>

        <section>
          <div className="ledger-head">
            <h2>Ledger</h2>
            <button type="button" className="secondary" disabled={busy} onClick={() => void runReaper()}>
              Run reaper
            </button>
          </div>

          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
          {!overview && !loadError ? <p className="empty">Loading the ledger…</p> : null}

          <div className="stack">
            {overview?.environments.length === 0 ? (
              <p className="empty">No previews yet. Open a pull request and it will show up here until the reaper removes it.</p>
            ) : null}
            {overview?.environments.map((env) => (
              <article className="env" key={env.id}>
                <header>
                  <div>
                    <h3>
                      {env.repository}#{env.prNumber}
                    </h3>
                    <p className="meta">
                      <span className="mono">{env.sha.slice(0, 12)}</span>
                      <span>{env.branch}</span>
                      <span>active {formatDelta(env.lastActiveAt)}</span>
                      <span>{env.status === "destroyed" ? `removed ${formatDelta(env.destroyedAt ?? env.updatedAt)}` : `expires ${formatDelta(env.expiresAt)}`}</span>
                      {env.destroyReason ? <span>reason {env.destroyReason}</span> : null}
                    </p>
                  </div>
                  <span className="status" data-status={env.status}>{env.status}</span>
                </header>
                {env.url ? (
                  <p className="url">
                    <a href={env.url} target="_blank" rel="noreferrer">{env.url}</a>
                  </p>
                ) : null}
                {env.error ? <p className="error">{env.error}</p> : null}
                {env.comments.at(-1) ? <p className="comment">{env.comments.at(-1)?.body.split("\n")[0]}</p> : null}
                {env.status === "ready" || env.status === "updating" || env.status === "provisioning" ? (
                  <div className="row-actions">
                    {env.status === "ready" ? (
                      <button type="button" className="secondary" disabled={busy} onClick={() => void act(env.id, "idle")}>
                        Mark idle
                      </button>
                    ) : null}
                    <button type="button" className="secondary" disabled={busy} onClick={() => void act(env.id, "destroy")}>
                      Destroy
                    </button>
                    {env.url ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void navigator.clipboard.writeText(env.url ?? "")}
                      >
                        Copy URL
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <div className="ledger-head" style={{ marginTop: "1.25rem" }}>
            <h2>Still deployed</h2>
          </div>
          <div className="stack">
            {overview && overview.deployments.length === 0 ? (
              <p className="empty">Nothing is running. Closed, idle, and expired previews are not billing.</p>
            ) : null}
            {overview?.deployments.map((deployment) => (
              <article className="deployment" key={deployment.deploymentId}>
                <div>
                  <strong>
                    {deployment.repository}#{deployment.prNumber}
                  </strong>
                  <p className="meta">
                    <span className="mono">{deployment.deploymentId}</span>
                    <span className="mono">{deployment.sha.slice(0, 12)}</span>
                  </p>
                  <p className="url">
                    <a href={deployment.url} target="_blank" rel="noreferrer">{deployment.url}</a>
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <p className="footer">
        {config?.deployer === "fake"
          ? "The deployer records a preview in a local file. Destroy removes that record."
          : `Each preview listens on its own port. The app sleeps after ${config?.sleepSeconds ?? 20}s without a request and wakes on the next visit. Destroy stops the port.`}{" "}
        The reaper also runs every {config ? Math.round(config.reaperIntervalMs / 1000) : 60}s. Webhook
        signatures are {config?.webhookVerification === "signed" ? "required" : "open in development until GITHUB_WEBHOOK_SECRET is set"}.
        This control plane has no authentication yet, so keep it on a private network.
      </p>
    </main>
  );
}
