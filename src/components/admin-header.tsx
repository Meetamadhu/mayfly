"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

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
          <p className="subtitle">Pull request previews that sleep when idle</p>
        </div>
      </div>
      <div className="mast-actions">
        <ThemeToggle theme={theme} onChange={chooseTheme} />
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
