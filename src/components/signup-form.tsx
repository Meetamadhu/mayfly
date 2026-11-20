"use client";

import { useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";

export function SignUpForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== again) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/users/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok) {
        setDone(body.username);
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
    <AppShell active="admin">
      <div className="admin-panel admin-in-shell">
        <section className="panel login-card" aria-label="Create an account">
          <h1>Create an account</h1>
          {done ? (
            <>
              <p className="notice" role="status">
                Thanks, {done}. Your account is waiting for the admin to approve it. Once they do, you can{" "}
                <a href="/admin/login">sign in</a>.
              </p>
            </>
          ) : (
            <>
              <p className="help login-lede">
                With an account you can wake, sleep, extend and keep previews awake. The admin approves each new account
                before it can be used.
              </p>
              <form onSubmit={(event) => void onSubmit(event)}>
                <label htmlFor="signup-username">Username</label>
                <input
                  id="signup-username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,31}"
                  title="3 to 32 letters, numbers, dashes or underscores, starting with a letter or number"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <label htmlFor="signup-password">Password</label>
                <input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={200}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="help">At least 10 characters.</p>
                <label htmlFor="signup-again">Password again</label>
                <input
                  id="signup-again"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={again}
                  onChange={(event) => setAgain(event.target.value)}
                />
                <button type="submit" className="login-submit" disabled={busy}>
                  {busy ? "Creating…" : "Create account"}
                </button>
              </form>
              {error ? (
                <p className="error" role="alert">
                  {error}
                </p>
              ) : null}
              <p className="help">
                Already have one? <a href="/admin/login">Sign in</a>.
              </p>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
