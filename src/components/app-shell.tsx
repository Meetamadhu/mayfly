"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MayflyMark } from "@/components/admin-header";
import { AppOnboarding, SHOW_INTRO_EVENT } from "@/components/app-onboarding";
import { ThemeToggle } from "@/components/theme-toggle";

export type AppPage = "dashboard" | "activity" | "cost" | "policies" | "comments" | "admin";

const NAV: { id: AppPage; href: string; label: string }[] = [
  { id: "dashboard", href: "/board", label: "Dashboard" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "cost", href: "/cost", label: "Cost & savings" },
  { id: "policies", href: "/policies", label: "Lifetime rules" },
  { id: "comments", href: "/pr-comments", label: "PR comments" },
  { id: "admin", href: "/admin", label: "Admin" },
];

/** The app's bottom tabs. Everything else sits in the More sheet. */
const TABS: { id: AppPage; href: string; label: string }[] = [
  { id: "dashboard", href: "/board", label: "Board" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "cost", href: "/cost", label: "Savings" },
];
const MORE: AppPage[] = ["policies", "comments", "admin"];

const TITLES: Record<AppPage, string> = {
  dashboard: "Previews",
  activity: "Activity",
  cost: "Savings",
  policies: "Lifetime rules",
  comments: "PR comments",
  admin: "Admin",
};

function NavIcon({ page }: { page: AppPage }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (page) {
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l3-7 4 14 3-7h4" />
        </svg>
      );
    case "cost":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
          <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        </svg>
      );
    case "policies":
      return (
        <svg {...common}>
          <path d="M6.5 3h11M6.5 21h11" />
          <path d="M7.5 3v3.5c0 2 4.5 3.5 4.5 5.5s-4.5 3.5-4.5 5.5V21M16.5 3v3.5c0 2-4.5 3.5-4.5 5.5s4.5 3.5 4.5 5.5V21" />
        </svg>
      );
    case "comments":
      return (
        <svg {...common}>
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
      );
    case "admin":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
  }
}

/**
 * The one sidebar + top bar every Mayfly screen shares (Dashboard, Activity, Cost & savings, Lifetime rules, PR comments, Admin).
 *
 * `search`: pages that can filter pass a controlled search; elsewhere the box searches the Dashboard
 * (submitting goes to /board?q=…).
 */
export function AppShell({
  active,
  children,
  githubConnected = false,
  search,
  onSignOut,
}: {
  active: AppPage;
  children: ReactNode;
  githubConnected?: boolean;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  onSignOut?: () => void | Promise<void>;
}) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [signedIn, setSignedIn] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { signedIn?: boolean }) => {
        if (!cancelled) setSignedIn(Boolean(body.signedIn));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMoreOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  function chooseTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mayfly-theme", next);
    } catch {
      // Storage can be blocked; the choice still applies to this page.
    }
    setTheme(next);
  }

  async function signOut() {
    if (onSignOut) {
      await onSignOut();
      return;
    }
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    setSignedIn(false);
  }

  return (
    <div className="board-app" data-nav={navOpen ? "open" : "closed"}>
      <aside className="board-sidebar" aria-label="Mayfly">
        <div className="board-sidebar-brand">
          <a className="board-brand" href="/">
            <MayflyMark className="board-mark" />
            <span>
              <span className="board-wordmark">Mayfly</span>
              <span className="board-tagline">Previews for every pull request</span>
            </span>
          </a>
          <button
            type="button"
            className="board-nav-toggle"
            aria-expanded={navOpen}
            aria-controls="board-side-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <nav id="board-side-nav" className="board-side-nav" aria-label="Pages">
          {NAV.map((item) => (
            <a key={item.id} href={item.href} aria-current={item.id === active ? "page" : undefined}>
              <NavIcon page={item.id} />
              <span>{item.label}</span>
            </a>
          ))}
          <button
            type="button"
            className="board-side-intro"
            onClick={() => {
              setNavOpen(false);
              window.dispatchEvent(new Event(SHOW_INTRO_EVENT));
            }}
          >
            Show the intro
          </button>
        </nav>
      </aside>

      <div className="board-main">
        <header className="board-topbar">
          {/* App only: a compact title in place of the website's search-first bar. */}
          <div className="app-title">
            <MayflyMark className="app-title-mark" />
            <span className="app-title-text" aria-hidden="true">{TITLES[active]}</span>
          </div>
          {search ? (
            <label className="board-search board-search-top">
              <span className="visually-hidden">{search.placeholder}</span>
              <input
                ref={searchRef}
                type="search"
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder}
              />
              <kbd className="board-search-kbd">Ctrl K</kbd>
            </label>
          ) : (
            <form className="board-search board-search-top board-search-shared" action="/board" method="get" role="search">
              <label className="visually-hidden" htmlFor="shell-search">
                Search previews by repo, branch or person
              </label>
              <input id="shell-search" ref={searchRef} type="search" name="q" placeholder="Search repo, branch or @person" />
              <kbd className="board-search-kbd">Ctrl K</kbd>
            </form>
          )}
          <div className="board-topbar-actions">
            {githubConnected ? (
              <span className="board-github-pill" title="GitHub token is configured">
                GitHub connected
              </span>
            ) : null}
            <ThemeToggle theme={theme} onChange={chooseTheme} />
            {signedIn ? (
              <button type="button" className="secondary board-auth-btn" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : (
              <a className="btn secondary board-auth-btn" href="/admin/login">
                Admin sign-in
              </a>
            )}
          </div>
        </header>

        <main className="board-content">{children}</main>
      </div>

      {/* App only (hidden on the website): bottom tabs and the More sheet. */}
      <nav className="app-tabbar" aria-label="App pages">
        {TABS.map((tab) => (
          <a key={tab.id} href={tab.href} aria-current={tab.id === active ? "page" : undefined}>
            <NavIcon page={tab.id} />
            <span>{tab.label}</span>
          </a>
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls="app-more"
          data-current={MORE.includes(active) ? "true" : undefined}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.9" />
            <circle cx="12" cy="12" r="1.9" />
            <circle cx="19" cy="12" r="1.9" />
          </svg>
          <span>More</span>
        </button>
      </nav>

      {moreOpen ? (
        <div className="app-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            id="app-more"
            className="app-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="app-sheet-handle" aria-hidden="true" />
            <nav aria-label="More pages">
              {NAV.filter((item) => MORE.includes(item.id)).map((item) => (
                <a key={item.id} href={item.href} aria-current={item.id === active ? "page" : undefined}>
                  <NavIcon page={item.id} />
                  <span>{item.label}</span>
                </a>
              ))}
            </nav>
            <div className="app-sheet-row">
              <span>Appearance</span>
              <ThemeToggle theme={theme} onChange={chooseTheme} />
            </div>
            <button
              type="button"
              className="app-sheet-link"
              onClick={() => {
                setMoreOpen(false);
                window.dispatchEvent(new Event(SHOW_INTRO_EVENT));
              }}
            >
              Show the intro again
            </button>
            {signedIn ? (
              <button
                type="button"
                className="app-sheet-link"
                onClick={() => {
                  setMoreOpen(false);
                  void signOut();
                }}
              >
                Sign out
              </button>
            ) : (
              <a className="app-sheet-link" href="/admin/login">
                Admin sign-in
              </a>
            )}
          </div>
        </div>
      ) : null}

      <AppOnboarding />
    </div>
  );
}
