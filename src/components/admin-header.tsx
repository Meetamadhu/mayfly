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
    <svg className={className} viewBox="84 66 362 362" aria-hidden="true">
      <g fill="none" stroke="var(--ink, currentColor)" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M304 103 H210 A103 103 0 0 0 107 206 V305 A103 103 0 0 0 210 408 H309 A103 103 0 0 0 412 305 V207"
          strokeWidth="34"
        />
        <path
          d="M178.5 216.5 V295.5 M178.5 256.5 A40 40 0 0 1 258.5 256.5 V295.5 M258.5 256.5 A40 40 0 0 1 338.5 256.5 V295.5"
          strokeWidth="39"
        />
      </g>
      <g fill="var(--mint, currentColor)">
        <circle cx="362.5" cy="145.5" r="25" />
        <circle cx="395.5" cy="113.5" r="11" opacity="0.78" />
        <circle cx="415" cy="95" r="8.5" opacity="0.55" />
        <circle cx="429.5" cy="80.5" r="6" opacity="0.38" />
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
