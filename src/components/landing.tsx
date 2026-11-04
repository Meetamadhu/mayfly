"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

const STEPS = [
  { label: "Open a PR", note: "GitHub sends a signed webhook" },
  { label: "Build", note: "The PR's own Dockerfile runs" },
  { label: "Share", note: "One preview URL for the team" },
  { label: "Sleep & wake", note: "Idle containers stop, then start on visit" },
  { label: "Clean up", note: "Close or expiry removes the preview" },
];

const CAPTIONS = [
  "A pull request opens. Mayfly receives the webhook and starts a preview.",
  "It builds that exact commit from the repository's Dockerfile.",
  "Reviewers open one link. No shared staging to fight over.",
  "After a short idle stretch the container sleeps, then wakes on the next visit.",
  "Closing the PR, or letting it expire, removes the container and its image.",
];

function MayflyMark({ className }: { className?: string }) {
  // Same path as the concept mark in mayfly-landing.html.
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

export function Landing() {
  const [step, setStep] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setStep((current) => (current + 1) % STEPS.length), 2800);
    return () => window.clearInterval(timer);
  }, []);

  function chooseTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mayfly-theme", next);
    } catch {
      // Storage can be blocked.
    }
    setTheme(next);
  }

  return (
    <main className="landing">
      <header className="landing-header">
        <div className="landing-nav wrap">
          <a className="landing-brand" href="/">
            <MayflyMark className="landing-mark" />
            mayfly
          </a>
          <nav className="landing-nav-links" aria-label="Landing">
            <a href="#workflow">How it works</a>
            <a href="#features">Features</a>
            <a href="#faq">FAQ</a>
            <a href="/board">Board</a>
          </nav>
          <div className="landing-nav-actions">
            <ThemeToggle theme={theme} onChange={chooseTheme} />
            <a className="landing-btn landing-btn-nav" href="/admin/login">
              Sign in
            </a>
            <a className="landing-btn landing-btn-cta" href="/board">
              Open board
            </a>
          </div>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-glow" aria-hidden="true" />
        <div className="landing-hero-inner wrap">
          <div className="landing-hero-main">
            <h1>Mayfly</h1>
            <p className="landing-lede landing-lede-lead">Give every pull request a place to land.</p>
            <p className="landing-lede">
              Spin up a preview for every pull request. Review together. Clean up when you&apos;re done.
            </p>
            <div className="landing-actions">
              <a className="landing-btn landing-btn-primary" href="/board">
                Open the board
              </a>
              <a className="landing-btn landing-btn-ghost" href="/admin/login">
                Admin sign-in
              </a>
            </div>
          </div>
          <div className="landing-hero-visual" aria-hidden="true">
            <MayflyMark className="landing-hero-mark" />
            <div className="landing-hero-stage">
              <span>pr / checkout / 142</span>
              <span>preview live</span>
              <span>sleeps when idle</span>
            </div>
          </div>
        </div>
      </section>

      <div className="landing-orbit">
        <div className="wrap landing-orbit-row">
          <div className="landing-orbit-workflow">
            <p className="landing-orbit-kicker">Designed around your workflow</p>
            <ul className="landing-orbit-stack">
              <li>
                <span aria-hidden="true">⑂</span>
                GitHub
              </li>
              <li>
                <span aria-hidden="true">▰</span>
                Docker
              </li>
            </ul>
          </div>
          <div className="landing-orbit-chips">
            <span>GitHub webhooks</span>
            <span>Docker builds</span>
            <span>Sleep &amp; wake</span>
            <span>Automatic cleanup</span>
          </div>
        </div>
      </div>

      <section className="landing-section wrap" id="workflow">
        <div className="landing-section-head">
          <h2>Here for the review. Gone when you&apos;re done.</h2>
          <p>Follow a preview from the pull request to a clean exit.</p>
        </div>
        <div className="landing-workflow">
          <ol className="landing-steps">
            {STEPS.map((item, index) => (
              <li key={item.label}>
                <button
                  type="button"
                  className="landing-step"
                  data-active={index === step ? "true" : "false"}
                  data-done={index < step ? "true" : "false"}
                  onClick={() => setStep(index)}
                >
                  <span className="landing-step-num">{index + 1}</span>
                  <strong>{item.label}</strong>
                  <small>{item.note}</small>
                </button>
              </li>
            ))}
          </ol>
          <p className="landing-caption" aria-live="polite">
            {CAPTIONS[step]}
          </p>
        </div>
      </section>

      <section className="landing-section wrap" id="features">
        <div className="landing-section-head">
          <h2>Less staging to manage. More signal in every review.</h2>
          <p>Mayfly builds the PR&apos;s own code, then keeps capacity tied to active visits.</p>
        </div>
        <div className="landing-features">
          <article>
            <h3>Sleep when idle</h3>
            <p>
              After a short stretch without visitors the container stops. The next visit wakes it without a rebuild.
            </p>
          </article>
          <article>
            <h3>Built from the PR</h3>
            <p>
              In Docker mode Mayfly clones the pull request, builds its Dockerfile, and runs that exact commit in its
              own container.
            </p>
          </article>
          <article>
            <h3>A clean exit</h3>
            <p>
              Closing the PR, or letting the lifetime expire, removes the container and its image so nothing lingers.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-compare">
        <div className="wrap">
          <h2>Staging shouldn&apos;t stay on forever.</h2>
          <div className="landing-compare-grid">
            <div>
              <h3>Shared staging</h3>
              <ul>
                <li>One environment for competing changes</li>
                <li>Resources keep running between reviews</li>
                <li>Cleanup is easy to forget</li>
              </ul>
            </div>
            <div>
              <h3>Mayfly</h3>
              <ul>
                <li>An isolated preview for each pull request</li>
                <li>Sleep on idle, wake on the next visit</li>
                <li>Cleanup on close or expiry</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section wrap" id="faq">
        <div className="landing-section-head">
          <h2>Before your first preview</h2>
          <p>Short answers for the questions that come up first.</p>
        </div>
        <div className="landing-faq">
          <details>
            <summary>What does Mayfly build?</summary>
            <p>
              In Docker mode it builds the pull request&apos;s own Dockerfile for repositories on the allow-list. Pull
              requests from forks are refused. The always-on Render board runs placeholder mode.
            </p>
          </details>
          <details>
            <summary>How does a preview start?</summary>
            <p>
              GitHub sends a signed webhook when a pull request opens or updates. Mayfly builds that commit and serves
              a preview URL. Closing the PR removes it.
            </p>
          </details>
          <details>
            <summary>What happens when nobody is looking?</summary>
            <p>
              After the configured idle time the container sleeps. The next visit starts it again. The preview still
              expires when its lifetime runs out.
            </p>
          </details>
          <details>
            <summary>Where can I try it?</summary>
            <p>
              Open the public board for live previews, or sign in on Admin to simulate events. The full Docker path
              runs in a Codespace when that environment is up.
            </p>
          </details>
        </div>
      </section>

      <footer className="landing-foot wrap">
        <a className="landing-brand" href="/">
          <MayflyMark className="landing-mark" />
          Mayfly
        </a>
        <span>Ephemeral pull request previews</span>
        <a href="#faq">Questions</a>
      </footer>
    </main>
  );
}
