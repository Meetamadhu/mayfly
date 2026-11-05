"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export function MayflyMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 36" aria-hidden="true">
      <path
        d="M19 30V13M20 18C-1 13 1-5 16 9l4 9C41-3 43 12 21 20M20 20C1 15 6 31 18 25M22 20c19-8 13 12 0 5M17 7l-3-5m8 5 4-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AdminHeader({ onSignOut }: { onSignOut?: () => void }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const signedIn = Boolean(onSignOut);

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
        <a className="mast-brand" href="/">
          <MayflyMark className="mast-mark" />
          <span className="mast-wordmark">Mayfly</span>
        </a>
        <p className="subtitle">Pull request previews that sleep when idle</p>
      </div>
      <div className="mast-actions">
        <ThemeToggle theme={theme} onChange={chooseTheme} />
        <a className="btn secondary" href="/board">
          Board
        </a>
        {signedIn ? (
          <>
            <a className="btn secondary" href="/admin">
              Admin
            </a>
            <button type="button" className="secondary" onClick={onSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <a className="btn secondary" href="/admin/login">
            Admin sign-in
          </a>
        )}
      </div>
    </header>
  );
}
