"use client";

import { useCallback, useEffect, useState } from "react";

type User = {
  id: string;
  username: string;
  status: "pending" | "active" | "disabled";
  createdAt: string;
  approvedAt: string | null;
  lastSignInAt: string | null;
};

type Entry = {
  at: string;
  actor: string;
  role: "admin" | "user";
  action: string;
  target: string | null;
  detail: string | null;
};

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
}

function ago(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return when(iso);
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", credentials: "include", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error ?? "Something went wrong. Try again.");
  return body;
}

/** Admin only: approve sign-ups, turn accounts off and on, sign someone out, remove an account. */
export function TeamAccountsPanel() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await call("/api/admin/users")).users);
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't load the accounts.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(user: User, action: "approve" | "disable" | "enable" | "remove" | "signout") {
    if (action === "remove" && !window.confirm(`Remove ${user.username}'s account? They'd have to sign up again.`)) return;
    setBusyId(user.id);
    try {
      await call(`/api/admin/users/${encodeURIComponent(user.id)}?action=${action}`, { method: "POST" });
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "That didn't work.");
    } finally {
      setBusyId(null);
    }
  }

  const pending = users?.filter((user) => user.status === "pending") ?? [];
  const others = users?.filter((user) => user.status !== "pending") ?? [];

  return (
    <section className="panel team-panel" aria-label="Team accounts">
      <h2>Team accounts</h2>
      <p className="help">
        People sign up at <span className="mono">/signup</span> and can sign in once you approve them. They can wake,
        sleep, extend and keep previews awake. Only you can remove previews, change lifetime rules, use backups and
        manage accounts.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!users ? <p className="empty">Loading…</p> : null}

      {users && pending.length > 0 ? (
        <>
          <h3 className="team-subhead">Waiting for you ({pending.length})</h3>
          <ul className="team-list">
            {pending.map((user) => (
              <li key={user.id}>
                <span className="team-name">{user.username}</span>
                <span className="team-meta">signed up {when(user.createdAt)}</span>
                <span className="team-actions">
                  <button type="button" disabled={busyId === user.id} onClick={() => void act(user, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="secondary" disabled={busyId === user.id} onClick={() => void act(user, "remove")}>
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {users && others.length > 0 ? (
        <>
          <h3 className="team-subhead">Accounts</h3>
          <ul className="team-list">
            {others.map((user) => (
              <li key={user.id} data-status={user.status}>
                <span className="team-name">{user.username}</span>
                <span className="team-meta">
                  {user.status === "disabled" ? "turned off · " : ""}last signed in {when(user.lastSignInAt)}
                </span>
                <span className="team-actions">
                  {user.status === "active" ? (
                    <>
                      <button type="button" className="secondary" disabled={busyId === user.id} onClick={() => void act(user, "signout")}>
                        Sign out
                      </button>
                      <button type="button" className="secondary" disabled={busyId === user.id} onClick={() => void act(user, "disable")}>
                        Turn off
                      </button>
                    </>
                  ) : (
                    <button type="button" className="secondary" disabled={busyId === user.id} onClick={() => void act(user, "enable")}>
                      Turn on
                    </button>
                  )}
                  <button type="button" className="destroy" disabled={busyId === user.id} onClick={() => void act(user, "remove")}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {users && users.length === 0 ? (
        <p className="empty">No one has signed up yet. Send your team the link to /signup.</p>
      ) : null}
    </section>
  );
}

const SAID: Record<string, string> = {
  signin: "signed in",
  "preview.sleep": "put to sleep",
  "preview.mark_active": "marked as in use",
  "preview.extend": "extended",
  "preview.keep_awake": "kept awake",
  "preview.keep_awake_off": "let sleep again",
  "preview.remove": "removed",
  "user.approve": "approved",
  "user.disable": "turned off",
  "user.enable": "turned on",
  "user.remove": "removed the account of",
  "user.signout": "signed out",
};

export function describeEntry(entry: Entry) {
  const verb = SAID[entry.action] ?? entry.action;
  return [verb, entry.target, entry.detail].filter(Boolean).join(" ");
}

/** Everyone signed in: who did what to which preview or account, newest first. */
export function ActivityLogPanel() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setEntries((await call("/api/audit")).entries);
      setError(null);
      setNow(Date.now());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't load the activity log.");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <section className="panel" aria-label="Who did what">
      <h2>Who did what</h2>
      <p className="help">Every sign-in and every change people make to previews and accounts, newest first.</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {entries && entries.length === 0 ? <p className="empty">Nothing yet.</p> : null}
      {entries && entries.length > 0 ? (
        <ol className="audit-list">
          {entries.slice(0, 30).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span className="audit-who" data-role={entry.role}>
                {entry.actor}
              </span>
              <span className="audit-what">{describeEntry(entry)}</span>
              <time className="audit-when" dateTime={entry.at} title={when(entry.at)}>
                {ago(entry.at, now)}
              </time>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
