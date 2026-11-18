"use client";

import { useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";

export default function AdminLoginPage() {
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
        // Only known pages, so the link can't send someone elsewhere after signing in.
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.assign(next === "/policies" || next === "/pr-comments" ? next : "/admin");
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
    <AppShell active="admin">
      <div className="admin-panel admin-in-shell">
      <section className="panel login-card" aria-label="Admin sign in">
        <h1>Admin sign-in</h1>
        <p className="help login-lede">Admins only. Ask the project owner for the token.</p>
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {wrong ? <p className="error" role="alert">Wrong token</p> : null}
      </section>
      <p className="login-back">
        <a href="/board">Back to dashboard</a>
      </p>
      </div>
    </AppShell>
  );
}
