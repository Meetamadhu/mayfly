"use client";

import { useEffect, useState } from "react";
import { MayflyMark } from "@/components/admin-header";
import { StateGlyph } from "@/components/previews-view";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The public home page from the design: a top bar, the headline, a picture of the Previews page in a browser
 * window (drawn with HTML, so it stays sharp), the four states a preview goes through, the life of one preview,
 * and the questions people ask first.
 */

const STATES: { tone: string; glyph: string; title: string; text: string }[] = [
  { tone: "building", glyph: "building", title: "Opens", text: "A pull request opens. Mayfly builds it and posts one link on the PR." },
  { tone: "awake", glyph: "awake", title: "Awake", text: "Reviewers click the link and see the change running in seconds." },
  { tone: "asleep", glyph: "asleep", title: "Sleeps", text: "After a quiet half hour the preview stops. Nothing runs, nothing bills." },
  { tone: "removed", glyph: "failed", title: "Removed", text: "Merge or close the PR and the preview is deleted for you." },
];

const LIFE: { state: "build" | "awake" | "asleep"; share: number }[] = [
  { state: "build", share: 3 },
  { state: "awake", share: 12 },
  { state: "asleep", share: 52 },
  { state: "awake", share: 9 },
  { state: "asleep", share: 24 },
];

const MOMENTS: { at: number; when: string; what: string }[] = [
  { at: 0, when: "Mon 10:02", what: "Pull request #42 opens" },
  { at: 3, when: "10:02", what: "Built from its own code in 14 s" },
  { at: 15, when: "10:30", what: "Nobody's looking, so it falls asleep" },
  { at: 67, when: "Tue 09:40", what: "A reviewer opens the link and it wakes up" },
  { at: 100, when: "Tue 16:15", what: "Merged, and the preview is gone" },
];

/** Sample rows for the picture of the Previews page. */
const SAMPLE: { repo: "W" | "A"; tone: string; title: string; pr: number; who: string; branch: string; state: "awake" | "asleep" | "building"; visit: string; note?: string; cost: string }[] = [
  { repo: "W", tone: "blue", title: "Add billing export", pr: 42, who: "priya", branch: "feat/export", state: "awake", visit: "12 min ago", cost: "$0.42" },
  { repo: "A", tone: "orange", title: "Fix date parsing", pr: 41, who: "sam", branch: "fix/dates", state: "asleep", visit: "3 h ago", cost: "$0.18" },
  { repo: "W", tone: "blue", title: "New onboarding flow", pr: 44, who: "lee", branch: "ux/onboard", state: "building", visit: "just now", cost: "$0.03" },
  { repo: "A", tone: "orange", title: "Upgrade dependencies", pr: 39, who: "sam", branch: "chore/deps", state: "asleep", visit: "1 day ago", note: "Expires in 3 h", cost: "$0.11" },
  { repo: "W", tone: "blue", title: "Dark mode tokens", pr: 37, who: "ana", branch: "design/tokens", state: "awake", visit: "4 min ago", cost: "$0.57" },
  { repo: "A", tone: "orange", title: "Search rewrite", pr: 36, who: "raj", branch: "feat/search", state: "asleep", visit: "2 days ago", cost: "$0.22" },
];

const ACTION = { awake: "Open", asleep: "Wake", building: "Logs" } as const;
const PILL = { awake: "Awake", asleep: "Asleep", building: "Building" } as const;

function PreviewsPicture() {
  return (
    <div className="lp-shot" role="img" aria-label="The Previews page: six pull requests, two awake, three asleep and one building, with $18.40 saved this month.">
      <div className="lp-shot-bar" aria-hidden="true">
        <span className="lp-shot-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="lp-shot-url">mayfly.app/previews</span>
      </div>
      <div className="lp-shot-body" aria-hidden="true">
        <div className="lp-shot-side">
          <div className="lp-shot-brand">
            <MayflyMark className="lp-shot-mark" />
            mayfly
          </div>
          <p className="lp-shot-heading">Workspace</p>
          <p className="lp-shot-nav" data-on="1">
            Previews <b>6</b>
          </p>
          <p className="lp-shot-nav">Activity</p>
          <p className="lp-shot-nav">Cost</p>
          <p className="lp-shot-heading">Admin</p>
          <p className="lp-shot-nav">Admin</p>
          <p className="lp-shot-nav">Lifetime rules</p>
          <p className="lp-shot-nav">PR comments</p>
        </div>
        <div className="lp-shot-main">
          <div className="lp-shot-top">
            <span>
              acme / <b>Previews</b>
            </span>
            <span className="lp-shot-search">Search repo, branch or person</span>
          </div>
          <div className="lp-shot-content">
            <div className="lp-shot-head">
              <div>
                <b className="lp-shot-h1">Previews</b>
                <span>6 pull requests across 2 repos. Idle previews are asleep and cost nothing.</span>
              </div>
              <span className="lp-shot-btns">
                <i>Filters</i>
                <i>Sort: Last visit</i>
              </span>
            </div>
            <div className="lp-shot-stats">
              {[
                ["awake", "Awake", "2", "sleeps in 6–18 min"],
                ["asleep", "Asleep", "3", "wake on next visit"],
                ["building", "Building", "1", "about 14 s left"],
                ["saved", "Saved this month", "$18.40", "68% vs always on"],
              ].map(([tone, label, value, hint]) => (
                <div key={tone} className="lp-shot-stat">
                  <span>
                    <i className="act-icon" data-tone={tone === "saved" ? "saved" : tone}>
                      <StateGlyph tone={tone} />
                    </i>
                    {label}
                  </span>
                  <span>
                    <b>{value}</b>
                    <small>{hint}</small>
                  </span>
                </div>
              ))}
            </div>
            <div className="lp-shot-tabs">
              <b>All</b>
              <span>Awake</span>
              <span>Asleep</span>
              <span>Building</span>
            </div>
            <div className="lp-shot-table">
              <div className="lp-shot-row lp-shot-thead">
                <span>Pull request</span>
                <span className="lp-shot-wide">Branch</span>
                <span>Status</span>
                <span className="lp-shot-wide">Last visit</span>
                <span className="lp-shot-wide">Cost</span>
                <span />
              </div>
              {SAMPLE.map((row) => (
                <div key={row.pr} className="lp-shot-row">
                  <span className="lp-shot-pr">
                    <i className="pv-avatar" data-tone={row.tone}>
                      {row.repo}
                    </i>
                    <span>
                      <b>{row.title}</b>
                      <small>
                        #{row.pr} · @{row.who}
                      </small>
                    </span>
                  </span>
                  <span className="lp-shot-wide">
                    <code>{row.branch}</code>
                  </span>
                  <span>
                    <i className="lp-shot-pill" data-state={row.state}>
                      {PILL[row.state]}
                    </i>
                  </span>
                  <span className="lp-shot-wide">
                    {row.visit}
                    {row.note ? <small className="lp-shot-warn">{row.note}</small> : null}
                  </span>
                  <span className="lp-shot-wide">{row.cost}</span>
                  <span className="lp-shot-act">
                    <i data-state={row.state}>{ACTION[row.state]}</i>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type Live = { up: number; awake: number } | null;

export function Landing() {
  const [live, setLive] = useState<Live>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    let cancelled = false;
    fetch("/api/environments", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || !body?.summary) return;
        setLive({ up: Number(body.summary.live) || 0, awake: Number(body.summary.awake) || 0 });
      })
      .catch(() => {});
    fetch("/api/admin/session", { credentials: "include", cache: "no-store" })
      .then((response) => response.json())
      .then((body: { signedIn?: boolean }) => {
        if (!cancelled) setSignedIn(Boolean(body.signedIn));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
    <main className="lp">
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <a className="lp-brand" href="/" aria-label="Mayfly home">
            <MayflyMark className="lp-brand-mark" />
            <span>mayfly</span>
          </a>
          <div className="lp-nav-actions">
            <ThemeToggle theme={theme} onChange={chooseTheme} />
            {signedIn ? (
              <a className="lp-signin" href="/admin">
                Admin
              </a>
            ) : (
              <a className="lp-signin" href="/admin/login">
                Sign in
              </a>
            )}
            <a className="lp-btn" href="/board">
              Open dashboard
            </a>
          </div>
        </div>
      </header>

      <section className="lp-hero2" aria-labelledby="lp-title">
        <p className="lp-badge">
          <i aria-hidden="true" />
          {live && live.up > 0
            ? `${live.up} preview${live.up === 1 ? "" : "s"} up right now, ${live.awake} awake`
            : "Preview environments for pull requests"}
        </p>
        <h1 id="lp-title">
          Every pull request gets a <span className="lp-live-word">live</span> preview.{" "}
          <span className="lp-line2">
            Then it goes to <span className="lp-sleep-word">sleep.</span>
          </span>
        </h1>
        <p className="lp-lede2">
          Reviewers open one link and see the change running. Idle previews sleep and wake on the next visit, so you
          pay for minutes, not days.
        </p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-lg" href="/board">
            Open dashboard
          </a>
          <a className="lp-btn-ghost lp-btn-lg" href="#how">
            See how it works
          </a>
        </div>
      </section>

      <div className="lp-shot-wrap">
        <PreviewsPicture />
      </div>

      <section className="lp-section" id="how" aria-labelledby="lp-how-title">
        <p className="lp-kicker">How it works</p>
        <h2 id="lp-how-title">Four states, four colours.</h2>
        <ol className="lp-states">
          {STATES.map((state) => (
            <li key={state.title} data-tone={state.tone}>
              <span className="act-icon" data-tone={state.glyph === "failed" ? "failed" : state.glyph} aria-hidden="true">
                <StateGlyph tone={state.glyph} />
              </span>
              <h3>{state.title}</h3>
              <p>{state.text}</p>
            </li>
          ))}
        </ol>

        <figure className="lp-life">
          <figcaption>The life of one preview</figcaption>
          <div
            className="lp-line"
            role="img"
            aria-label="A preview builds in seconds, is awake while people look at it, sleeps for most of its life, and is removed when the pull request is merged."
          >
            {LIFE.map((part, index) => (
              <span key={index} data-life={part.state} style={{ flexGrow: part.share }} />
            ))}
            {MOMENTS.map((moment) => (
              <i key={moment.what} className="lp-tick" style={{ left: `${moment.at}%` }} />
            ))}
          </div>
          <ol className="lp-moments">
            {MOMENTS.map((moment) => (
              <li key={moment.what}>
                <span className="lp-when">{moment.when}</span>
                <span>{moment.what}</span>
              </li>
            ))}
          </ol>
          <p className="lp-key">
            <span data-life="awake" /> awake <span data-life="asleep" /> asleep <span data-life="build" /> building
          </p>
        </figure>
      </section>

      <section className="lp-section lp-faq" id="faq" aria-labelledby="lp-faq-title">
        <h2 id="lp-faq-title">Questions people ask first</h2>
        <details>
          <summary>Which pull requests get a preview?</summary>
          <p>
            Pull requests on the repositories an admin has allowed. Pull requests from forks don&apos;t, to keep the
            server safe.
          </p>
        </details>
        <details>
          <summary>How long does a preview stay up?</summary>
          <p>
            Until the pull request is merged or closed, or its lifetime runs out. Admins choose the lifetime for each
            repository, and a <code>keep-preview</code> label keeps one open.
          </p>
        </details>
        <details>
          <summary>What does it cost?</summary>
          <p>Only the time a preview is awake. The Cost page shows an estimate of what sleeping has saved.</p>
        </details>
        <details>
          <summary>Can I keep previews private?</summary>
          <p>Yes. Set a team password and preview links ask for it once. Signed-in admins are never asked.</p>
        </details>
        <details>
          <summary>Where can I try it?</summary>
          <p>
            Open the dashboard to see the previews that are up now, or sign in as an admin to try a pull request
            without going to GitHub.
          </p>
        </details>
      </section>

      <footer className="lp-foot">
        <span>© Mayfly</span>
      </footer>
    </main>
  );
}
