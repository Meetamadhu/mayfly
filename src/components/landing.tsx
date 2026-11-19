"use client";

import { useEffect, useState } from "react";
import { AdminHeader, MayflyMark } from "@/components/admin-header";

/**
 * One preview's life, drawn the same way as the lifespan line on every preview card: this is the page's one
 * picture. Widths are shares of the whole life; the moments below line up with where they happen.
 */
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

type Live = { up: number; awake: number } | null;

export function Landing() {
  const [live, setLive] = useState<Live>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/environments", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || !body?.summary) return;
        const up = Number(body.summary.live) || 0;
        setLive({ up, awake: Number(body.summary.awake) || 0 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="landing landing-v2">
      <div className="landing-chrome wrap">
        <AdminHeader />
      </div>

      <div className="wrap">
        <section className="lp-hero" aria-labelledby="lp-title">
          <h1 id="lp-title">A preview for every pull request, gone when it&apos;s merged.</h1>
          <p className="lp-lede">
            Reviewers click one link and see the change running. When nobody&apos;s using it the preview sleeps, so
            it costs almost nothing, and when the pull request closes Mayfly removes it.
          </p>
          <div className="lp-actions">
            <a className="btn" href="/board">
              Open the board
            </a>
            <a className="btn secondary" href="/admin/login">
              Admin sign-in
            </a>
            {live ? (
              <span className="lp-live" aria-live="polite">
                {live.up === 0
                  ? "No previews are up right now."
                  : `${live.up} preview${live.up === 1 ? " is" : "s are"} up right now, ${live.awake} awake.`}
              </span>
            ) : null}
          </div>

          <figure className="lp-life">
            <figcaption>The life of one preview</figcaption>
            <div className="lp-line" role="img" aria-label="A preview builds in seconds, is awake while people look at it, sleeps for most of its life, and is removed when the pull request is merged.">
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

        <section className="lp-facts" aria-label="What Mayfly does">
          <div>
            <h2>Built from the pull request</h2>
            <p>Mayfly builds the exact commit with the repository&apos;s own Dockerfile and runs it on its own.</p>
          </div>
          <div>
            <h2>Asleep when idle</h2>
            <p>After a short quiet spell the app stops. The next visit wakes it in a second or two, no rebuild.</p>
          </div>
          <div>
            <h2>Cleans up after itself</h2>
            <p>Merge or close the pull request, or let its time run out, and the preview is deleted.</p>
          </div>
        </section>

        <section className="lp-faq" id="faq" aria-labelledby="lp-faq-title">
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
              Only the time a preview is awake. The Cost page shows an estimate of what sleeping has saved this month.
            </p>
          </details>
          <details>
            <summary>Where can I try it?</summary>
            <p>
              Open the board to see the previews that are up now, or sign in as an admin to try a pull request without
              going to GitHub.
            </p>
          </details>
        </section>
      </div>

      <footer className="landing-foot wrap">
        <a className="landing-brand" href="/">
          <MayflyMark className="landing-mark" />
          Mayfly
        </a>
        <span>A live preview for every pull request</span>
        <a href="#faq">Questions</a>
      </footer>
    </main>
  );
}
