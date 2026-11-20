"use client";

import { useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";

// Only known pages, so a crafted link can't send someone elsewhere after signing in.
function nextPage(role: "admin" | "user") {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next === "/pr-comments") return next;
  if (next === "/policies" && role === "admin") return next;
  return "/admin";
}

function TeamSignIn() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/users/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok) {
        window.location.assign(nextPage("user"));
        return;
      }
      setError(body?.error ?? "That didn't work. Try again.");
    } catch {
      setError("Couldn't reach Mayfly. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-card" aria-label="Team sign in">
      <h1>Sign in</h1>
      <p className="help login-lede">
        Use the account you signed up with. New here? <a href="/signup">Create an account</a>, then wait for the admin to
        approve it.
      </p>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="team-username">Username</label>
        <input
          id="team-username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label htmlFor="team-password">Password</label>
        <input
          id="team-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function AdminSignIn() {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setWrong(false);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.location.assign(nextPage("admin"));
        return;
      }
      setWrong(true);
    } catch {
      setWrong(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel login-card login-admin">
      <summary>Admin? Sign in with the admin token</summary>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="admin-token">Admin token</label>
        <div className="token-field">
          <input
            id="admin-token"
            type={show ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            className="secondary"
            aria-pressed={show}
            aria-label={show ? "Hide token" : "Show token"}
            onClick={() => setShow((visible) => !visible)}
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in as admin"}
        </button>
      </form>
      {wrong ? (
        <p className="error" role="alert">
          That token didn&apos;t work. Check it and try again.
        </p>
      ) : null}
    </details>
  );
}

export default function SignInPage() {
  return (
    <AppShell active="admin">
      <div className="admin-panel admin-in-shell">
        <TeamSignIn />
        <AdminSignIn />
        <p className="login-back">
          <a href="/board">Back to dashboard</a>
        </p>
      </div>
    </AppShell>
  );
}
