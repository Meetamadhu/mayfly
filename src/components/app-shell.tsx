"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MayflyMark } from "@/components/admin-header";
import { AppOnboarding, SHOW_INTRO_EVENT } from "@/components/app-onboarding";
import { ThemeToggle } from "@/components/theme-toggle";

export type AppPage = "dashboard" | "activity" | "cost" | "policies" | "settings" | "comments" | "admin";

const NAV: { id: AppPage; href: string; label: string; group: "workspace" | "admin" }[] = [
  { id: "dashboard", href: "/board", label: "Previews", group: "workspace" },
  { id: "activity", href: "/activity", label: "Activity", group: "workspace" },
  { id: "cost", href: "/cost", label: "Cost", group: "workspace" },
  { id: "admin", href: "/admin", label: "Admin", group: "admin" },
  { id: "policies", href: "/policies", label: "Lifetime rules", group: "admin" },
  { id: "settings", href: "/preview-settings", label: "Preview settings", group: "admin" },
  { id: "comments", href: "/pr-comments", label: "PR comments", group: "admin" },
];

/** The app's bottom tabs. Everything else sits in the More sheet. */
const TABS: { id: AppPage; href: string; label: string }[] = [
  { id: "dashboard", href: "/board", label: "Previews" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "cost", href: "/cost", label: "Cost" },
];
const MORE: AppPage[] = ["admin", "policies", "settings", "comments"];

const TITLES: Record<AppPage, string> = {
  dashboard: "Previews",
  activity: "Activity",
  cost: "Cost",
  policies: "Lifetime rules",
  settings: "Preview settings",
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
    case "settings":
      return (
        <svg {...common}>
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
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

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0z" />
    </svg>
  );
}

/** Top bar, right: who you are and signing in or out, behind the avatar. The intro and light/dark sit beside it. */
function AccountMenu({ signedIn, onSignOut }: { signedIn: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="board-account" ref={ref}>
      <button
        type="button"
        className="board-avatar"
        data-signed-in={signedIn ? "true" : "false"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={signedIn ? "Account: Admin, signed in" : "Account: visitor"}
        onClick={() => setOpen((value) => !value)}
      >
        {signedIn ? "A" : <PersonIcon />}
      </button>
      {open ? (
        <div className="board-account-panel" role="dialog" aria-label="Account">
          <div className="board-account-who">
            <span className="board-avatar" data-signed-in={signedIn ? "true" : "false"} aria-hidden="true">
              {signedIn ? "A" : <PersonIcon />}
            </span>
            <span>
              <strong>{signedIn ? "Admin" : "Visitor"}</strong>
              <span>{signedIn ? "Signed in" : "Viewing only"}</span>
            </span>
          </div>
          {signedIn ? (
            <button
              type="button"
              className="board-account-item"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              Sign out
            </button>
          ) : (
            <a className="board-account-item board-account-primary" href="/admin/login">
              Admin sign-in
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
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
  crumb,
  previewCount,
}: {
  active: AppPage;
  children: ReactNode;
  githubConnected?: boolean;
  /** Shown before the page name in the top bar, e.g. the GitHub owner of the repositories. */
  crumb?: string;
  /** The number on the Previews item in the sidebar. */
  previewCount?: number;
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
          <a className="board-brand" href="/" aria-label="Mayfly home">
            <MayflyMark className="board-mark" />
            <span className="board-wordmark">mayfly</span>
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
          {(["workspace", "admin"] as const).map((group) => (
            <div key={group} className="board-side-group" data-group={group}>
              {group === "workspace" ? (
                <p className="board-side-heading">Workspace</p>
              ) : (
                <p className="board-side-heading">
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                  </svg>
                  Admin
                  {!signedIn ? <span className="board-side-tag">Admins only</span> : null}
                </p>
              )}
              {NAV.filter((item) => item.group === group).map((item) => (
                <a key={item.id} href={item.href} aria-current={item.id === active ? "page" : undefined}>
                  <NavIcon page={item.id} />
                  <span>{item.label}</span>
                  {item.id === "dashboard" && typeof previewCount === "number" ? (
                    <span className="board-side-count" aria-label={`${previewCount} previews`}>
                      {previewCount}
                    </span>
                  ) : null}
                </a>
              ))}
            </div>
          ))}

          <div className="board-side-foot">
            {githubConnected ? (
              <p className="board-github-note" title="GitHub token is configured">
                <span aria-hidden="true" /> GitHub connected
              </p>
            ) : null}
          </div>
        </nav>
      </aside>

      <div className="board-main">
        <header className="board-topbar">
          {/* App only: a compact title in place of the website's search-first bar. */}
          <div className="app-title">
            <MayflyMark className="app-title-mark" />
            <span className="app-title-text" aria-hidden="true">{TITLES[active]}</span>
          </div>
          <p className="board-crumb" data-large="1">
            {crumb ? (
              <>
                <span className="board-crumb-owner">{crumb}</span>
                <span className="board-crumb-sep" aria-hidden="true">/</span>
              </>
            ) : null}
            <span className="board-crumb-page">{TITLES[active]}</span>
          </p>
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
              <input id="shell-search" ref={searchRef} type="search" name="q" placeholder="Search repo, branch or person" />
              <kbd className="board-search-kbd">Ctrl K</kbd>
            </form>
          )}
          <div className="board-topbar-actions">
            <button
              type="button"
              className="board-help"
              aria-label="Intro: how Mayfly works"
              title="How Mayfly works"
              onClick={() => window.dispatchEvent(new Event(SHOW_INTRO_EVENT))}
            >
              <span className="board-help-mark" aria-hidden="true">
                {/* An open book: the intro is a short guide to how Mayfly works. */}
                <svg viewBox="0 0 24 24">
                  <path d="M3 5.5c3-1.2 6-1 9 1 3-2 6-2.2 9-1v13c-3-1.2-6-1-9 1-3-2-6-2.2-9-1z" />
                  <path d="M12 6.5v13" />
                </svg>
              </span>
              <span className="board-help-label">Intro</span>
            </button>
            <div className="board-appearance" title="Appearance">
              <span className="visually-hidden">Appearance</span>
              <ThemeToggle theme={theme} onChange={chooseTheme} />
            </div>
            <AccountMenu signedIn={signedIn} onSignOut={() => void signOut()} />
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
