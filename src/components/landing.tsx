"use client";

import { useEffect, useState } from "react";
import { MayflyMark } from "@/components/admin-header";
import { StateGlyph } from "@/components/previews-view";
import { ThemeToggle } from "@/components/theme-toggle";
import { AppOnboarding, SHOW_INTRO_EVENT } from "@/components/app-onboarding";
import { PLAN_IDS, PLANS, planLines } from "@/lib/plans";

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

/** Footer social links: icons only. GitHub is the project; LinkedIn and X show when their public URLs are set. */
const SOCIAL: { id: "github" | "linkedin" | "x"; label: string; href: string }[] = [
  { id: "github", label: "GitHub", href: process.env.NEXT_PUBLIC_SOCIAL_GITHUB?.trim() || "https://github.com/Meetamadhu/mayfly" },
  ...(process.env.NEXT_PUBLIC_SOCIAL_LINKEDIN?.trim()
    ? [{ id: "linkedin" as const, label: "LinkedIn", href: process.env.NEXT_PUBLIC_SOCIAL_LINKEDIN.trim() }]
    : []),
  ...(process.env.NEXT_PUBLIC_SOCIAL_X?.trim()
    ? [{ id: "x" as const, label: "X", href: process.env.NEXT_PUBLIC_SOCIAL_X.trim() }]
    : []),
];

function SocialIcon({ id }: { id: "github" | "linkedin" | "x" }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", "aria-hidden": true as const };
  if (id === "github") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M12 .5C5.73.5.75 5.48.75 11.76c0 4.97 3.22 9.18 7.69 10.66.56.1.77-.24.77-.54 0-.27-.01-1.15-.02-2.09-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 .1.72 2.64 2.72 1.9.08-.74.39-1.25.71-1.54-2.5-.28-5.12-1.25-5.12-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.7 10.7 0 0 1 2.82-.38c.96 0 1.92.13 2.82.38 2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08 0 1.5-.01 2.71-.01 3.08 0 .3.2.65.77.54A11.02 11.02 0 0 0 23.25 11.76C23.25 5.48 18.27.5 12 .5z" />
      </svg>
    );
  }
  if (id === "linkedin") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S.02 4.88.02 3.5 1.14 1 2.5 1s2.48 1.12 2.48 2.5zM.24 8.25h4.52V23H.24V8.25zM8.34 8.25h4.33v2.01h.06c.6-1.14 2.08-2.34 4.28-2.34 4.58 0 5.42 3.01 5.42 6.93V23h-4.52v-6.84c0-1.63-.03-3.73-2.27-3.73-2.28 0-2.63 1.78-2.63 3.61V23H8.34V8.25z" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="currentColor">
      <path d="M18.24 2.25h3.27l-7.14 8.16 8.4 11.34h-6.58l-5.15-6.73-5.9 6.73H1.88l7.64-8.72L1.5 2.25h6.75l4.66 6.16 5.33-6.16zm-1.15 17.55h1.81L7.08 4.05H5.14l11.95 15.75z" />
    </svg>
  );
}

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

/** The people who use Mayfly, and what each of them does with it. */
const WHO: { title: string; text: string }[] = [
  { title: "Developers", text: "Open a pull request and get a live preview without setting anything up. The website does everything the Android app does." },
  { title: "Reviewers, product managers and clients", text: "Open one link and see the real change running, on a laptop or a phone, instead of reading a diff or looking at screenshots." },
  { title: "Designers", text: "Check how a change really looks, mobile layouts included, and pin a comment on the exact spot that looks wrong." },
  { title: "QA and testers", text: "Test each pull request on its own preview, not on one shared staging server where changes get mixed together." },
  { title: "Team leads and admins", text: "Keep a preview awake for a demo, remove old ones, start a preview of any branch and catch up on recent activity." },
  { title: "Managers", text: "See on the Cost page how much sleeping previews save, and set limits so spend stays predictable." },
];
/** Situations Mayfly is used in, each with the part of Mayfly that does it. */
const USE_CASES: { title: string; text: string; feature: string }[] = [
  {
    title: "Review a design change before it ships",
    text: "A designer opens the preview from the pull request, marks the spot that looks wrong and leaves a comment. It shows up on the pull request too.",
    feature: "Feedback pins",
  },
  {
    title: "Test each change on its own",
    text: "QA tests one pull request at a time on its own preview, instead of queueing for a shared staging server where changes get mixed together.",
    feature: "A preview per pull request",
  },
  {
    title: "Get a client’s sign-off",
    text: "Send the client the preview link and they see the real thing, not screenshots. With a team password set, the link stays private.",
    feature: "Team password",
  },
  {
    title: "Show work in a stand-up or demo",
    text: "Open the live preview instead of sharing your screen. A keep-preview label keeps it up until the demo is over.",
    feature: "keep-preview label",
  },
  {
    title: "Cut what staging costs",
    text: "Previews nobody is looking at sleep and use nothing, then wake in seconds. The Cost page shows what that saved this month.",
    feature: "Sleep and wake",
  },
  {
    title: "Try a branch before opening a pull request",
    text: "Admins start a preview of any branch from the dashboard, with its own size, lifetime and budget.",
    feature: "New preview",
  },
];

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
            <button
              type="button"
              className="board-help lp-nav-intro"
              aria-label="Intro: how Mayfly works"
              title="How Mayfly works"
              onClick={() => window.dispatchEvent(new Event(SHOW_INTRO_EVENT))}
            >
              <span className="board-help-mark" aria-hidden="true">
                {/* An open book, the same Intro button as on the dashboard. */}
                <svg viewBox="0 0 24 24">
                  <path d="M3 5.5c3-1.2 6-1 9 1 3-2 6-2.2 9-1v13c-3-1.2-6-1-9 1-3-2-6-2.2-9-1z" />
                  <path d="M12 6.5v13" />
                </svg>
              </span>
              <span className="board-help-label">Intro</span>
            </button>
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
          Every pull request gets a <span className="lp-live-word">live</span> preview, then it goes to{" "}
          <span className="lp-sleep-word">sleep.</span>
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

      <div className="lp-band lp-band-how">
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
      </div>

      <div className="lp-band lp-band-who">
        <section className="lp-section" id="who" aria-labelledby="lp-who-title">
          <p className="lp-kicker">Who it is for</p>
          <h2 id="lp-who-title">Everyone who needs to see the change.</h2>
          <ul className="lp-who">
            {WHO.map((person) => (
              <li key={person.title}>
                <h3>{person.title}</h3>
                <p>{person.text}</p>
              </li>
            ))}
          </ul>
          <p className="lp-who-note">
            Best fit: small and mid-size teams that work on GitHub. A Dockerfile in the repository is used as it is, and Mayfly writes one for common web apps that don&apos;t have one.
          </p>
        </section>
      </div>

      <div className="lp-band lp-band-uses">
        <section className="lp-section" id="use-cases" aria-labelledby="lp-uses-title">
          <p className="lp-kicker">Use cases</p>
          <h2 id="lp-uses-title">What teams use it for.</h2>
          <ul className="lp-uses">
            {USE_CASES.map((use) => (
              <li key={use.title}>
                <h3>{use.title}</h3>
                <p>{use.text}</p>
                <span className="lp-use-feature">{use.feature}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="lp-band lp-band-app">
        <section className="lp-section" id="app" aria-labelledby="lp-app-title">
          <p className="lp-kicker">Android app</p>
          <h2 id="lp-app-title">Mayfly on your phone.</h2>
          <p className="lp-app-lede">
            For the reviewers, designers, testers and managers who check or approve work on the go: open a preview, see
            which are awake or asleep, and keep one up for a demo. Developers can keep using the website, which does
            everything the app does.
          </p>
          <div className="lp-app">
            <aside className="lp-app-get" aria-labelledby="lp-app-get-title">
              <h3 id="lp-app-get-title">Get the Android app</h3>
              <p>Opens full screen, like any other app, and keeps itself up to date: every improvement to Mayfly shows up the next time you open it.</p>
              <a className="lp-btn lp-btn-lg" href="/downloads/mayfly.apk" download="Mayfly.apk">
                Download for Android
              </a>
              <p className="lp-app-small">
                APK, about 1 MB. Android asks once to allow installs from your browser. Not on Android? Add this page to
                your home screen instead.
              </p>
            </aside>
          </div>
        </section>
      </div>

      <div className="lp-band lp-band-plans">
        <section className="lp-section" id="plans" aria-labelledby="lp-plans-title">
          <p className="lp-kicker">Plans</p>
          <h2 id="lp-plans-title">Pay for the hours someone is looking.</h2>
          <p className="lp-app-lede">
            Idle previews sleep and cost nothing, so you pay only while a preview is awake, billed by the second.
            This is demo pricing: nothing is charged, and admins change plan on the Pricing page.
          </p>
          <ul className="lp-plans">
            {PLAN_IDS.map((id) => {
              const plan = PLANS[id];
              return (
                <li key={plan.id}>
                  <h3>{plan.name}</h3>
                  <p className="lp-plan-price">
                    <strong>{plan.price}</strong> <span>{plan.per}</span>
                  </p>
                  <p className="lp-plan-blurb">{plan.blurb}</p>
                  <ul>
                    {planLines(plan).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <a className="lp-btn lp-btn-lg lp-plans-cta" href="/pricing#calculator">
            Estimate your bill
          </a>
        </section>
      </div>

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
          <p>
            Only the time a preview is awake, from ₹5 an hour for a Standard preview, billed by the second. Asleep
            previews are free, and the Sandbox includes 30 awake hours a month (see <a href="#plans">Plans</a>).
          </p>
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

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <a className="lp-brand" href="/" aria-label="Mayfly home">
              <MayflyMark className="lp-footer-mark" />
              <span>mayfly</span>
            </a>
            <p>
              A live preview for every pull request. Idle previews sleep, wake on the next visit, and are removed after
              the merge.
            </p>
          </div>
          <nav className="lp-footer-cols" aria-label="Footer">
            <div>
              <h2>Product</h2>
              <a href="#how">How it works</a>
              <a href="#who">Who it is for</a>
              <a href="#use-cases">Use cases</a>
              <a href="#app">Android app</a>
              <a href="#plans">Plans</a>
              <a href="#faq">Questions</a>
            </div>
            <div>
              <h2>Dashboard</h2>
              <a href="/board">Previews</a>
              <a href="/activity">Activity</a>
              <a href="/cost">Cost</a>
              <a href="/pricing">Pricing</a>
            </div>
            <div>
              <h2>Admins</h2>
              <a href={signedIn ? "/admin" : "/admin/login"}>{signedIn ? "Admin" : "Sign in"}</a>
              <a href="/policies">Lifetime rules</a>
              <a href="/pr-comments">PR comments</a>
            </div>
          </nav>
        </div>
        <div className="lp-footer-bottom">
          <span>© {new Date().getFullYear()} Mayfly</span>
          <nav className="lp-footer-social" aria-label="Social">
            {SOCIAL.map((item) => (
              <a key={item.id} href={item.href} target="_blank" rel="noopener noreferrer" aria-label={item.label} title={item.label}>
                <SocialIcon id={item.id} />
              </a>
            ))}
          </nav>
          <span>Preview environments for pull requests</span>
        </div>
      </footer>
      <AppOnboarding showOnLoad={false} />
    </main>
  );
}
