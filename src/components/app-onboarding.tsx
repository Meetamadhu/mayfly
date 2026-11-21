"use client";

import { useEffect, useRef, useState } from "react";
import { MayflyMark } from "@/components/admin-header";
import { isAppMode } from "@/lib/app-mode";

/** Set once the intro has been finished or skipped, so it shows on the first launch only. */
export const ONBOARDED_KEY = "mayfly-onboarded";
/** Fired by "Show the intro again" in the app's More sheet. */
export const SHOW_INTRO_EVENT = "mayfly:show-intro";

type Slide = { title: string; body: string; art: "previews" | "sleep" | "savings" };

const SLIDES: Slide[] = [
  {
    title: "A live preview for every pull request",
    body: "Open a pull request and Mayfly builds it, then posts the link on GitHub. Nobody waits for a shared staging server.",
    art: "previews",
  },
  {
    title: "Sleeps when idle, wakes in seconds",
    body: "Previews nobody is looking at go to sleep. Opening the link wakes them up again.",
    art: "sleep",
  },
  {
    title: "See what you’re saving",
    body: "Mayfly counts the hours each preview sleeps and estimates what keeping them all awake would have cost.",
    art: "savings",
  },
];

function Art({ kind }: { kind: Slide["art"] }) {
  if (kind === "previews") {
    const cards = [
      { pos: "back", pr: "PR #41", branch: "fix/login-copy", tone: "asleep", label: "Asleep" },
      { pos: "mid", pr: "PR #43", branch: "feat/rates", tone: "work", label: "Building" },
      { pos: "front", pr: "PR #42", branch: "feat/checkout", tone: "ready", label: "Ready" },
    ] as const;
    return (
      <div className="onb-art" aria-hidden="true">
        {cards.map((card) => (
          <div key={card.pr} className={`onb-card onb-card-${card.pos}`}>
            <span className="onb-row">
              <span className="onb-pr">{card.pr}</span>
              <span className="onb-pill" data-tone={card.tone}>
                {card.label}
              </span>
            </span>
            <span className="onb-branch">{card.branch}</span>
            {card.pos === "front" ? <span className="onb-link">pr-42.preview ↗</span> : null}
          </div>
        ))}
      </div>
    );
  }
  if (kind === "sleep") {
    return (
      <div className="onb-art" aria-hidden="true">
        <div className="onb-card onb-card-back onb-sleep">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <span className="onb-pr">Asleep</span>
          <span className="onb-branch">idle for 20 min</span>
        </div>
        <div className="onb-card onb-card-front onb-wake">
          <span className="onb-pr">Waking up</span>
          <span className="onb-meter"><span /></span>
          <span className="onb-branch">ready in about 3 s</span>
        </div>
      </div>
    );
  }
  return (
    <div className="onb-art" aria-hidden="true">
      <div className="onb-card onb-card-front onb-savings">
        <span className="onb-branch">Saved this month</span>
        <span className="onb-big">$4.19</span>
        <span className="onb-bars">
          <span style={{ height: "92%" }} />
          <span style={{ height: "18%" }} data-tone="mayfly" />
        </span>
        <span className="onb-bar-labels">
          <span>Always awake</span>
          <span>With Mayfly</span>
        </span>
      </div>
    </div>
  );
}

/**
 * First-launch intro, shown only inside the Mayfly app (not on the website). Three slides you can swipe, with
 * Skip and Next, then Get started. Remembered per phone; "Show the intro again" in the More sheet brings it back.
 */
export function AppOnboarding() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAppMode()) return;
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
      // Storage blocked: show it, and it will show again next time, which is harmless.
    }
    if (!seen) setOpen(true);
    const show = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener(SHOW_INTRO_EVENT, show);
    return () => window.removeEventListener(SHOW_INTRO_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.onboarding = "open";
    trackRef.current?.scrollTo({ left: 0 });
    dialogRef.current?.focus();
    return () => {
      delete document.documentElement.dataset.onboarding;
    };
  }, [open]);

  function finish() {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      // Ignore: see above.
    }
    setOpen(false);
  }

  function goTo(next: number) {
    const track = trackRef.current;
    if (!track) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({ left: next * track.clientWidth, behavior: reduce ? "auto" : "smooth" });
    setIndex(next);
  }

  // Swiping moves the track; keep the dots and the button in step with it.
  function onScroll() {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const current = Math.round(track.scrollLeft / track.clientWidth);
    if (current !== index) setIndex(current);
  }

  if (!open) return null;
  const last = index === SLIDES.length - 1;

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Welcome to Mayfly" tabIndex={-1} ref={dialogRef}>
      <div className="onb-top">
        <span className="onb-brand">
          <MayflyMark className="onb-mark" />
          Mayfly
        </span>
        {last ? null : (
          <button type="button" className="onb-skip" onClick={finish}>
            Skip
          </button>
        )}
      </div>

      <div className="onb-track" ref={trackRef} onScroll={onScroll}>
        {SLIDES.map((slide, i) => (
          <section
            key={slide.art}
            className="onb-slide"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${SLIDES.length}`}
            aria-hidden={i !== index}
          >
            <div className="onb-stage">
              <Art kind={slide.art} />
            </div>
            <h2>{slide.title}</h2>
            <p>{slide.body}</p>
          </section>
        ))}
      </div>

      <div className="onb-foot">
        <div className="onb-dots" role="tablist" aria-label="Choose a slide">
          {SLIDES.map((slide, i) => (
            <button
              key={slide.art}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Slide ${i + 1}`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
        <button
          type="button"
          className="onb-next"
          onClick={() => (last ? finish() : goTo(index + 1))}
        >
          {last ? "Get started" : "Next"}
        </button>
      </div>
    </div>
  );
}
