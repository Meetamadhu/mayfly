"use client";

import { useEffect, useState } from "react";

export function AdminHeader({ onSignOut }: { onSignOut?: () => void }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function chooseTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mayfly-theme", next);
    } catch {
      // Storage can be blocked. The choice still applies to this page.
    }
    setTheme(next);
  }

  return (
    <header className="mast">
      <div className="mast-copy">
        <div className="mast-title">
          <h1>Mayfly</h1>
          <p className="subtitle">Ephemeral environments</p>
        </div>
      </div>
      <div className="mast-actions">
        <div className="theme-toggle" role="group" aria-label="Color theme">
          <button type="button" aria-pressed={theme === "light"} onClick={() => chooseTheme("light")}>
            Light
          </button>
          <button type="button" aria-pressed={theme === "dark"} onClick={() => chooseTheme("dark")}>
            Dark
          </button>
        </div>
        <a className="admin-link" href="/board">
          Board
        </a>
        {onSignOut ? (
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
      </div>
    </header>
  );
}
