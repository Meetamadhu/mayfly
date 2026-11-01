"use client";

import { useState, type FormEvent } from "react";
import { AdminHeader } from "@/components/admin-header";

export default function AdminLoginPage() {
  const [token, setToken] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setWrong(false);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.location.assign("/admin");
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
    <main className="shell admin-panel">
      <AdminHeader />
      <section className="panel admin" aria-label="Admin sign in">
        <h1>Admin</h1>
        <form className="admin-row" onSubmit={(event) => void onSubmit(event)}>
          <label>
            Admin token
            <input
              type="password"
              autoComplete="current-password"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !token.trim()}>
            Sign in
          </button>
        </form>
        {wrong ? <p className="error" role="alert">Wrong token</p> : null}
      </section>
    </main>
  );
}
