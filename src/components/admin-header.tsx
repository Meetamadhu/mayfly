"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Mayfly's mark: a rounded "m" with a mint "live" dot, the same drawing as the app icon in public/icons
 * (temporary until the final logo). The m follows the text colour; the dot is always mint.
 */
/**
 * The Mayfly logo: an open window with an "m" inside and a trail of dots leaving through the gap (a preview that
 * goes away when it's done). Drawn in the page's ink and mint so it works on light and dark backgrounds. The app
 * icon files in public/icons are the same drawing on the navy square.
 */
export function MayflyMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="84 64 364 364" aria-hidden="true">
      <g fill="none" stroke="var(--ink, currentColor)" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M305 103 H207 A100 100 0 0 0 107 203 V310 A100 100 0 0 0 207 410 H313 A100 100 0 0 0 413 310 V205"
          strokeWidth="34"
        />
        <path
          d="M178 218 V296 M178 257 A40 40 0 0 1 258 257 V296 M258 257 A40 40 0 0 1 338 257 V296"
          strokeWidth="40"
        />
      </g>
      <g fill="var(--mint, currentColor)">
        <circle cx="347.5" cy="164" r="25" />
        <circle cx="385" cy="130" r="14.5" />
        <circle cx="414" cy="104.5" r="11" />
        <circle cx="437.5" cy="85" r="7.5" />
      </g>
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
