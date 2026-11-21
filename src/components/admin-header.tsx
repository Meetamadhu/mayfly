"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Mayfly's mark: a rounded "m" with a mint "live" dot, the same drawing as the app icon in public/icons
 * (temporary until the final logo). The m follows the text colour; the dot is always mint.
 */
export function MayflyMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="26 26 64 58" aria-hidden="true">
      <path
        d="M33 76 V52 a10.5 10.5 0 0 1 21 0 V76 M54 52 a10.5 10.5 0 0 1 21 0 V76"
        fill="none"
        stroke="var(--ink, currentColor)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="82" cy="36" r="5.6" fill="var(--mint, currentColor)" />
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
