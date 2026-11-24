"use client";

import { useEffect, useRef, useState } from "react";
import { StateGlyph } from "@/components/previews-view";
import {
  RECENT_TABS,
  inTab,
  isUnread,
  recentGroup,
  shortAgo,
  type RecentItem,
  type RecentKind,
  type RecentTab,
} from "@/lib/recent-activity";

/**
 * "Recent activity": a sheet that slides up on phones and in from the right on wide screens. Rows open the
 * preview's details on the Previews page.
 */

const GLYPH: Record<RecentKind, string> = {
  visit: "awake",
  update: "update",
  created: "building",
  failed: "failed",
  asleep: "asleep",
  time: "time",
  removed: "failed",
  note: "note",
};

function KindIcon({ kind }: { kind: RecentKind }) {
  if (kind === "update")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19V5M6 11l6-6 6 6" />
      </svg>
    );
  if (kind === "note")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M5 7h14M5 12h14M5 17h9" />
      </svg>
    );
  return <StateGlyph tone={GLYPH[kind]} />;
}

export function RecentActivitySheet({
  open,
  items,
  now,
  readMs,
  onMarkRead,
  onClose,
}: {
  open: boolean;
  items: RecentItem[];
  now: number;
  readMs: number;
  onMarkRead: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<RecentTab>("all");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("#ra-title")?.focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const shown = items.filter((item) => inTab(item, tab));
  const groups: { name: string; items: RecentItem[] }[] = [];
  for (const item of shown) {
    const name = recentGroup(item.at, now);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(item);
    else groups.push({ name, items: [item] });
  }
  const unread = items.filter((item) => isUnread(item, readMs)).length;

  return (
    <dialog
      ref={dialogRef}
      className="ra"
      aria-labelledby="ra-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {open ? (
        <div className="ra-inner">
          <span className="ra-grip" aria-hidden="true" />
          <header className="ra-head">
            <div>
              <h2 id="ra-title" tabIndex={-1}>
                Recent activity
              </h2>
              <p>What every preview has been up to</p>
            </div>
            <button type="button" className="ra-close" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <div className="ra-tabs">
            <div className="ra-pills" role="tablist" aria-label="Show">
              {RECENT_TABS.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
            <button type="button" className="ra-read" disabled={unread === 0} onClick={onMarkRead}>
              Mark all read
            </button>
          </div>

          <div className="ra-scroll">
            {shown.length === 0 ? <p className="ra-empty">Nothing here yet.</p> : null}
            {groups.map((group) => (
              <section key={group.name} aria-label={group.name}>
                <h3 className="ra-group">{group.name}</h3>
                <ol className="ra-list">
                  {group.items.map((item) => {
                    const fresh = isUnread(item, readMs);
                    return (
                      <li key={item.key}>
                        <a className="ra-row" href={`/board?preview=${encodeURIComponent(item.envId)}`} data-kind={item.kind}>
                          <span className="ra-icon" data-kind={item.kind} aria-hidden="true">
                            <KindIcon kind={item.kind} />
                          </span>
                          <span className="ra-text">
                            <strong>{item.subject}</strong>
                            <span className="ra-label" data-kind={item.kind}>
                              {item.label}
                            </span>
                            {item.detail ? <span className="ra-detail">{item.detail}</span> : null}
                          </span>
                          <span className="ra-side">
                            <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                              {shortAgo(item.at, now)}
                            </time>
                            {fresh ? (
                              <span className="ra-dot">
                                <span className="visually-hidden">New</span>
                              </span>
                            ) : null}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>

          <footer className="ra-foot">
            <a href="/activity">Open full activity log</a>
          </footer>
        </div>
      ) : null}
    </dialog>
  );
}
