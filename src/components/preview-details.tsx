"use client";

import { SIZE_INFO, hourlyRate } from "@/lib/sizes";
import { useEffect, useRef, useState } from "react";
import {
  BuildLog,
  FailureSummary,
  estimatedCost,
  formatAgo,
  formatEstMoney,
  previewHref,
} from "@/components/board-parts";
import { StateGlyph, repoAvatar } from "@/components/previews-view";
import { detailState, endsText, lastBuildMs, statusCard, type DetailState } from "@/lib/preview-details";
import { formatEventTime, timelineLabel, timelineNewestFirst, timelineTone } from "@/lib/timeline";
import type { Environment } from "@/lib/types";
import type { PreviewAction } from "@/lib/use-preview-actions";
import { formatBytes, useResources } from "@/lib/use-resources";

/**
 * Everything about one preview: what it's doing now, the buttons to open or keep it awake, its details, CPU and
 * memory, and its history. A panel on the right on wide screens, the whole screen on phones.
 */

type Props = {
  env: Environment | null;
  demo: boolean;
  now: number;
  signedIn: boolean;
  busy: boolean;
  error: string | null;
  currency: string;
  costPerHour: number;
  fallbackSleepSeconds: number;
  usualBuildMs: number | null;
  /** The page the panel opened from, for the back button: "Previews", "Activity" or "Cost". */
  backLabel: string;
  onAction: (env: Environment, action: PreviewAction, hours?: number) => Promise<boolean> | void;
  onClose: () => void;
};

const GLYPH: Record<DetailState, string> = {
  awake: "awake",
  kept: "awake",
  asleep: "asleep",
  building: "building",
  failed: "failed",
  removing: "failed",
  removed: "failed",
};

export function PreviewDetails(props: Props) {
  const { env, onClose } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (env && !dialog.open) {
      dialog.showModal();
      // Start on the title rather than the back button, so no focus ring shows when the panel opens.
      dialog.querySelector<HTMLElement>("#pd-title")?.focus({ preventScroll: true });
    }
    if (!env && dialog.open) dialog.close();
  }, [env]);

  return (
    <dialog
      ref={dialogRef}
      className="pd"
      aria-labelledby="pd-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {env ? <PanelBody {...props} env={env} /> : null}
    </dialog>
  );
}

function PanelBody(props: Props & { env: Environment }) {
  const { env, demo, now, signedIn, busy, error, currency, costPerHour, backLabel, onAction, onClose } = props;
  const resources = useResources(15_000);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menuOpen]);

  const card = statusCard(env, now, { fallbackSleepSeconds: props.fallbackSleepSeconds, usualBuildMs: props.usualBuildMs });
  const state = card.state;
  const live = state !== "removed" && state !== "removing";
  const href = live ? previewHref(env.url) : null;
  const avatar = repoAvatar(env.repository);
  const title = demo ? "Demo preview" : env.title?.trim() || `PR #${env.prNumber}`;
  const usage = env.deploymentId ? resources?.previews?.[env.deploymentId] : undefined;
  const build = lastBuildMs(env);
  const rate = hourlyRate(env, costPerHour);
  const awakeCost = env.usage ? estimatedCost(env.usage.awakeSeconds, rate) : null;
  const savedCost = env.usage ? estimatedCost(env.usage.asleepSeconds, rate) : null;
  const events = timelineNewestFirst(env.events);
  // Keep-awake needs a preview whose sleep Mayfly can control (it reports awake or asleep).
  const canKeepAwake =
    signedIn && (env.status === "ready" || env.status === "updating") && (env.sleep === "awake" || env.sleep === "asleep");


  async function copyLink() {
    if (!href) return;
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.href).toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the link is still on the Open button.
    }
    setMenuOpen(false);
  }

  async function act(action: PreviewAction, hours?: number) {
    setMenuOpen(false);
    const done = await onAction(env, action, hours);
    if (done && action === "destroy") onClose();
  }

  const menuItems: { label: string; run: () => void; danger?: boolean }[] = [];
  if (href) menuItems.push({ label: copied ? "Link copied" : "Copy preview link", run: () => void copyLink() });
  if (signedIn && live) {
    if (state === "awake" || state === "kept") menuItems.push({ label: "Put to sleep now", run: () => void act("sleep") });
    if (state === "kept") menuItems.push({ label: "Stop keeping awake", run: () => void act("keep_awake_off") });
    menuItems.push({ label: "Extend by 4 hours", run: () => void act("extend", 4) });
    menuItems.push({ label: "Remove preview", run: () => void act("destroy"), danger: true });
  }

  return (
    <div className="pd-inner">
      <header className="pd-bar">
        <button type="button" className="pd-back" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {backLabel}
        </button>
        {menuItems.length > 0 ? (
          <div className="pd-menu" ref={menuRef}>
            <button
              type="button"
              className="pd-menu-btn"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="1.9" fill="currentColor" />
                <circle cx="12" cy="12" r="1.9" fill="currentColor" />
                <circle cx="19" cy="12" r="1.9" fill="currentColor" />
              </svg>
            </button>
            {menuOpen ? (
              <div className="pd-menu-list" role="menu">
                {menuItems.map((item) => (
                  <button key={item.label} type="button" role="menuitem" data-danger={item.danger ? "1" : undefined} disabled={busy} onClick={item.run}>
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="pd-scroll">
        <div className="pd-title-row">
          <span className="pv-avatar" data-tone={avatar.tone} aria-hidden="true">
            {avatar.letter}
          </span>
          <div>
            <h2 id="pd-title" tabIndex={-1}>
              {title}
            </h2>
            <p className="pd-sub">
              {demo ? "demo" : `#${env.prNumber}`} · <code>{demo ? "demo" : env.branch}</code>
            </p>
          </div>
        </div>

        <section className="pd-status" data-state={state} aria-label="Status">
          <div className="pd-status-head">
            <span className="act-icon" data-tone={GLYPH[state]} aria-hidden="true">
              <StateGlyph tone={GLYPH[state]} />
            </span>
            <div>
              <strong>{card.label}</strong>
              <span>{card.line}</span>
            </div>
          </div>
          {card.progress !== null ? (
            <div className="pd-progress" role="progressbar" aria-label={card.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(card.progress * 100)}>
              <span style={{ width: `${Math.round(card.progress * 100)}%` }} />
            </div>
          ) : null}
          {state === "failed" && env.error ? (
            <div className="pd-failure">
              <FailureSummary error={env.error} signedIn={signedIn} />
              {signedIn ? <BuildLog error={env.error} /> : null}
            </div>
          ) : null}
        </section>

        {live ? (
          <div className="pd-actions">
            {href && state !== "failed" && env.status !== "provisioning" ? (
              <a className="pd-btn pd-btn-main" href={href} target="_blank" rel="noopener noreferrer">
                {state === "asleep" ? "Wake and open" : "Open preview"}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 16L16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : null}
            {canKeepAwake ? (
              state === "kept" ? (
                <button type="button" className="pd-btn pd-btn-line" disabled={busy} onClick={() => void act("keep_awake_off")}>
                  Let it sleep again
                </button>
              ) : (
                <button type="button" className="pd-btn pd-btn-line" disabled={busy} onClick={() => void act("keep_awake", 2)}>
                  Keep awake for 2 hours
                </button>
              )
            ) : null}
          </div>
        ) : null}
        {!signedIn && live && state !== "failed" ? (
          <p className="pd-hint">
            <a href="/admin/login">Sign in as admin</a> to keep it awake, put it to sleep or remove it.
          </p>
        ) : null}
        {error ? (
          <p className="pd-error" role="alert">
            {error}
          </p>
        ) : null}

        <section aria-labelledby="pd-details-title">
          <h3 className="pd-heading" id="pd-details-title">
            Details
          </h3>
          <dl className="pd-list">
            <div>
              <dt>Repo</dt>
              <dd>{env.repository}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>
                <code>{env.branch}</code>
              </dd>
            </div>
            {env.author ? (
              <div>
                <dt>Author</dt>
                <dd>@{env.author}</dd>
              </div>
            ) : null}
            <div>
              <dt>Commit</dt>
              <dd>
                <code>{env.sha.slice(0, 8)}</code>
              </dd>
            </div>
            <div>
              <dt>Built in</dt>
              <dd>{build ? `${Math.max(1, Math.round(build / 1000))} s` : "–"}</dd>
            </div>
            <div>
              <dt>Opened</dt>
              <dd>{formatAgo(env.createdAt, now)}</dd>
            </div>
            <div>
              <dt>Last visit</dt>
              <dd>{formatAgo(env.lastActiveAt, now)}</dd>
            </div>
            {live ? (
              <div>
                <dt>Ends</dt>
                <dd>{demo ? "never, it's the demo" : endsText(env, now)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Size</dt>
              <dd>
                {SIZE_INFO[env.size ?? "standard"].label} · ~{formatEstMoney(rate, currency)}/hr awake
              </dd>
            </div>
            {typeof env.budget === "number" ? (
              <div>
                <dt>Budget</dt>
                <dd>
                  {formatEstMoney(awakeCost ?? 0, currency)} of {formatEstMoney(env.budget, currency)} used
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Cost so far</dt>
              <dd>
                {awakeCost === null ? "–" : formatEstMoney(awakeCost, currency)}
                {savedCost && savedCost > 0 ? <span className="pd-saved"> · saved {formatEstMoney(savedCost, currency)}</span> : null}
              </dd>
            </div>
            {state === "awake" || state === "kept" ? (
              <>
                <div>
                  <dt>CPU</dt>
                  <dd>{usage ? `${Math.round(usage.cpuPercent)}%` : resources?.previews === null ? "not measured here" : "measuring…"}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>
                    {usage
                      ? `${formatBytes(usage.memUsedBytes)}${usage.memLimitBytes !== null ? ` of ${formatBytes(usage.memLimitBytes)}` : ""}`
                      : resources?.previews === null
                        ? "not measured here"
                        : "measuring…"}
                  </dd>
                </div>
              </>
            ) : state === "asleep" ? (
              <div>
                <dt>CPU and memory</dt>
                <dd>none while asleep</dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section aria-labelledby="pd-history-title">
          <h3 className="pd-heading" id="pd-history-title">
            History
          </h3>
          {events.length === 0 ? (
            <p className="pd-hint">Nothing has happened to this preview yet.</p>
          ) : (
            <ol className="pd-history">
              {events.map((event, index) => (
                <li key={`${event.at}-${event.type}-${index}`} data-tone={timelineTone(event.type)}>
                  <span className="pd-dot" aria-hidden="true" />
                  <span className="pd-history-text">{timelineLabel(event)}</span>
                  <time dateTime={event.at}>{formatEventTime(event.at)}</time>
                </li>
              ))}
            </ol>
          )}
          <p className="pd-foot">Mayfly keeps the last 50 events for each preview.</p>
        </section>
      </div>
    </div>
  );
}

