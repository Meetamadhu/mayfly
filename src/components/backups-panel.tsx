"use client";

import { useCallback, useEffect, useState } from "react";

type Backup = { name: string; takenAt: string; bytes: number; beforeRestore: boolean };
type Listing = { keep: number; backups: Backup[] };

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Admin page: when the last backup was taken, a download for an off-server copy, and "Back up now". */
export function BackupsPanel() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/backups", { cache: "no-store", credentials: "include" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error ?? "Couldn't load the backups.");
      setListing({ keep: body.keep, backups: body.backups });
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't load the backups.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function backUpNow() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/backups", { method: "POST", credentials: "include" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error ?? "The backup wasn't saved.");
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The backup wasn't saved.");
    } finally {
      setBusy(false);
    }
  }

  const daily = listing?.backups.filter((item) => !item.beforeRestore) ?? [];
  const latest = daily[0] ?? null;

  return (
    <section className="panel config-check" aria-label="Backups">
      <h2>Backups</h2>
      <p className="help">
        Mayfly saves its preview records and lifetime rules once a day and keeps the newest {listing?.keep ?? 7}.
        They&apos;re on the same server, so download one now and then to keep a copy somewhere else.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <dl className="settings config-check-list">
        <div>
          <dt>Last backup</dt>
          <dd>{!listing ? "–" : latest ? when(latest.takenAt) : "None yet. The first one is taken a few minutes after Mayfly starts."}</dd>
        </div>
        <div>
          <dt>Kept</dt>
          <dd>{listing ? `${daily.length} of ${listing.keep}` : "–"}</dd>
        </div>
      </dl>
      <div className="backup-actions">
        {latest ? (
          <a className="btn secondary" href={`/api/admin/backups/${encodeURIComponent(latest.name)}`} download>
            Download latest
          </a>
        ) : null}
        <button type="button" className="secondary" disabled={busy} onClick={() => void backUpNow()}>
          {busy ? "Backing up…" : "Back up now"}
        </button>
      </div>
      <p className="help">To restore one, run deploy/aws/backup.sh on the server. It stops Mayfly while it does.</p>
    </section>
  );
}
