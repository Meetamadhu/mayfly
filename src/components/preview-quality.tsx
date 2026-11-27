"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { CheckRun } from "@/lib/smoke";
import type { Environment } from "@/lib/types";

/**
 * On a preview's panel: its smoke-check result, a comparison with production, and a one-off wake for a review.
 * Admins only. Re-running a check posts a new GitHub status; the screenshots need Chrome or Edge on the server.
 */

async function readBody(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string; environment?: Environment };
  if (!response.ok) throw new Error(body.error || `Something went wrong (error ${response.status}).`);
  return body;
}

export function PreviewChecks({
  env,
  busy,
  onBusy,
}: {
  env: Environment;
  busy: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = env.checks ?? null;
  const working = busy || localBusy;

  async function recheck() {
    setLocalBusy(true);
    onBusy?.(true);
    setError(null);
    setNotice(null);
    try {
      await readBody(
        await fetch(`/api/environments/${encodeURIComponent(env.id)}/checks`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ which: "smoke" }),
        }),
      );
      setNotice("Checks started. The result will show here and on the pull request in a moment.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't run the checks.");
    } finally {
      setLocalBusy(false);
      onBusy?.(false);
    }
  }

  return (
    <section aria-labelledby="pd-checks-title">
      <h3 className="pd-heading" id="pd-checks-title">
        Smoke checks
      </h3>
      {run ? <CheckSummary run={run} /> : <p className="pd-hint">No check has run on this commit yet. Mayfly runs them once the preview is ready.</p>}
      <div className="pd-quality-actions">
        <button type="button" className="pd-btn pd-btn-line" disabled={working || env.status !== "ready"} onClick={() => void recheck()}>
          {localBusy ? "Checking…" : "Run checks again"}
        </button>
      </div>
      {notice ? (
        <p className="pd-hint" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="pd-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function CheckSummary({ run }: { run: CheckRun }) {
  return (
    <div className="pd-checks" data-ok={run.ok ? "1" : "0"}>
      <p className="pd-checks-summary">
        <span className="adm-chip" data-tone={run.ok ? "ok" : "bad"}>
          {run.ok ? "Passed" : "Failed"}
        </span>
        {run.summary}
      </p>
      <ul>
        {run.results.map((result) => (
          <li key={`${result.path}-${result.expectStatus}`} data-ok={result.ok ? "1" : "0"}>
            <code>{result.path}</code>
            <span>
              {result.status === null ? "no answer" : `answered ${result.status}`}
              {result.expectStatus !== 200 || result.status !== result.expectStatus ? ` (wanted ${result.expectStatus})` : ""}
              {result.ms ? ` · ${result.ms} ms` : ""}
            </span>
            {result.problem ? <span className="pd-checks-problem">{result.problem}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreviewVisual({
  env,
  busy,
  onBusy,
}: {
  env: Environment;
  busy: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<"preview" | "production" | "diff">("diff");
  const result = env.visual ?? null;
  const working = busy || localBusy;
  const stamp = result?.at ?? "";

  async function recheck() {
    setLocalBusy(true);
    onBusy?.(true);
    setError(null);
    setNotice(null);
    try {
      await readBody(
        await fetch(`/api/environments/${encodeURIComponent(env.id)}/checks`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ which: "visual" }),
        }),
      );
      setNotice("Comparison started. The screenshots will show here in a moment.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't compare with production.");
    } finally {
      setLocalBusy(false);
      onBusy?.(false);
    }
  }

  if (!result && env.status !== "ready") {
    return (
      <section aria-labelledby="pd-visual-title">
        <h3 className="pd-heading" id="pd-visual-title">
          Compared with production
        </h3>
        <p className="pd-hint">Once this preview is ready, Mayfly can screenshot it next to production if a production address is set for the repository.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="pd-visual-title">
      <h3 className="pd-heading" id="pd-visual-title">
        Compared with production
      </h3>
      {result ? (
        <>
          <p className="pd-checks-summary">
            {result.mismatchPercent === null ? (
              <span className="adm-chip" data-tone="warn">
                Not compared
              </span>
            ) : (
              <span className="adm-chip" data-tone={result.mismatchPercent < 1 ? "ok" : result.mismatchPercent < 10 ? "warn" : "bad"}>
                {result.mismatchPercent}% different
              </span>
            )}
            {result.summary}
          </p>
          {result.problem ? <p className="pd-hint">{result.problem}</p> : null}
          {result.mismatchPercent !== null ? (
            <>
              <div className="pv-seg pd-visual-tabs" role="tablist" aria-label="Screenshot">
                {(
                  [
                    ["preview", "Preview"],
                    ["production", "Production"],
                    ["diff", "Differences"],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={kind === id} onClick={() => setKind(id)}>
                    {label}
                  </button>
                ))}
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element -- served from Mayfly's own API, not a static asset */}
              <img
                key={`${kind}-${stamp}`}
                className="pd-visual-img"
                src={`/api/environments/${encodeURIComponent(env.id)}/visual/${kind}?t=${encodeURIComponent(stamp)}`}
                alt={kind === "diff" ? "Where the preview differs from production" : kind === "preview" ? "Screenshot of the preview" : "Screenshot of production"}
              />
              <p className="pd-hint">
                Against {result.productionUrl}, at {result.width}×{result.height}.
              </p>
            </>
          ) : null}
        </>
      ) : (
        <p className="pd-hint">No comparison yet. Set a production address under Preview settings, or run one now.</p>
      )}
      <div className="pd-quality-actions">
        <button type="button" className="pd-btn pd-btn-line" disabled={working || env.status !== "ready"} onClick={() => void recheck()}>
          {localBusy ? "Comparing…" : "Compare again"}
        </button>
      </div>
      {notice ? (
        <p className="pd-hint" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="pd-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function PreviewWake({
  env,
  busy,
  onBusy,
}: {
  env: Environment;
  busy: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [at, setAt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wake = env.scheduledWake ?? null;
  const working = busy || localBusy;

  useEffect(() => {
    // Default: 30 minutes from now, in the browser's local time, for the datetime-local input.
    const soon = new Date(Date.now() + 30 * 60_000);
    soon.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    setAt(`${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
  }, [env.id]);

  async function schedule(event: FormEvent) {
    event.preventDefault();
    setLocalBusy(true);
    onBusy?.(true);
    setError(null);
    setNotice(null);
    try {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) throw new Error("Choose when to wake the preview.");
      await readBody(
        await fetch(`/api/environments/${encodeURIComponent(env.id)}/wake`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ at: when.toISOString(), minutes: Number(minutes) }),
        }),
      );
      setNotice("Wake scheduled.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't schedule the wake.");
    } finally {
      setLocalBusy(false);
      onBusy?.(false);
    }
  }

  async function cancel() {
    setLocalBusy(true);
    onBusy?.(true);
    setError(null);
    setNotice(null);
    try {
      await readBody(await fetch(`/api/environments/${encodeURIComponent(env.id)}/wake`, { method: "DELETE", credentials: "include" }));
      setNotice("Wake cancelled.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't cancel the wake.");
    } finally {
      setLocalBusy(false);
      onBusy?.(false);
    }
  }

  return (
    <section aria-labelledby="pd-wake-title">
      <h3 className="pd-heading" id="pd-wake-title">
        Wake for a review
      </h3>
      <p className="pd-hint">Start this preview at a chosen time and keep it awake, so it&apos;s warm when the review begins.</p>
      {wake ? (
        <p className="pd-checks-summary">
          <span className="adm-chip" data-tone="ok">
            {wake.startedAt ? "Awake now" : "Scheduled"}
          </span>
          {wake.startedAt
            ? `Kept awake until ${new Date(Date.parse(wake.at) + wake.minutes * 60_000).toLocaleString()}.`
            : `Wakes at ${new Date(wake.at).toLocaleString()} for ${wake.minutes} minutes.`}
        </p>
      ) : null}
      <form className="pd-wake-form" onSubmit={(event) => void schedule(event)}>
        <label className="pd-wake-field">
          <span>When</span>
          <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} required />
        </label>
        <label className="pd-wake-field">
          <span>Keep awake (minutes)</span>
          <input inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value.replace(/\D/g, ""))} min={15} max={720} required />
        </label>
        <div className="pd-quality-actions">
          <button type="submit" className="pd-btn pd-btn-line" disabled={working}>
            {localBusy ? "Saving…" : wake ? "Change wake" : "Schedule wake"}
          </button>
          {wake ? (
            <button type="button" className="pd-btn pd-btn-line" disabled={working} onClick={() => void cancel()}>
              Cancel wake
            </button>
          ) : null}
        </div>
      </form>
      {notice ? (
        <p className="pd-hint" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="pd-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
