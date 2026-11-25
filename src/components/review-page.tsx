"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MayflyMark } from "@/components/admin-header";
import type { FeedbackItem } from "@/lib/feedback";
import { commentNotes, frameAddress, numbered, pinsFor, samePage } from "@/lib/review";
import { formatAgoRounded } from "@/lib/timeline";

/**
 * The review page: the preview in a frame, with a Comment button to mark a spot and a list of the comments left on
 * it. The page inside the frame runs the pull request's code, so nothing secret goes into it: it only gets pin
 * positions, and it can only tell this page which page it's on and where the reviewer dragged.
 */

type PreviewInfo = {
  id: string;
  repository: string;
  prNumber: number;
  title: string | null;
  branch: string;
  sha: string;
  path: string;
};

type Loaded = {
  admin: boolean;
  preview: PreviewInfo;
  items: FeedbackItem[];
  link?: string | null;
  postsToGithub?: boolean;
};

type Draft = { x: number; y: number; w: number; h: number; viewportWidth: number; path: string };

const NAME_KEY = "mayfly-feedback-name";
const POLL_MS = 20_000;

function readName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {}
}

function cleanFramePath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  return value.slice(0, 300);
}

export function ReviewPage({ owner, name, pr }: { owner: string; name: string; pr: string }) {
  const api = `/api/feedback/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(pr)}`;
  const [key, setKey] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [framePath, setFramePath] = useState<string | null>(null);
  const [mode, setMode] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [editingName, setEditingName] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<"page" | "all">("page");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef<string | null>(null);

  const headers = useCallback((): Record<string, string> => (key ? { "x-mayfly-feedback-key": key } : {}), [key]);

  const load = useCallback(
    async (initial: boolean, currentKey: string | null) => {
      try {
        const response = await fetch(api, {
          credentials: "same-origin",
          cache: "no-store",
          headers: currentKey ? { "x-mayfly-feedback-key": currentKey } : {},
        });
        const body = (await response.json().catch(() => ({}))) as Partial<Loaded> & { ok?: boolean; error?: string };
        if (!response.ok || !body.ok || !body.preview) {
          if (initial) setFailure({ status: response.status, message: body.error || "The review page couldn't load. Try again." });
          return;
        }
        setData(body as Loaded);
        if (initial) {
          const target = location.hash.startsWith("#c-") ? location.hash.slice(3) : null;
          const item = target ? body.items?.find((entry) => entry.id === target) : undefined;
          if (item) {
            pendingFocus.current = item.id;
            setActive(item.id);
            setTab("all");
          }
          setFrameSrc(frameAddress(body.preview.path, item?.path ?? "/"));
        }
      } catch {
        if (initial) setFailure({ status: 0, message: "Mayfly can't be reached. Check your connection and try again." });
      }
    },
    [api],
  );

  useEffect(() => {
    const given = new URLSearchParams(location.search).get("key");
    const k = given && /^[0-9a-f]{16,64}$/.test(given) ? given : null;
    setKey(k);
    const saved = readName();
    setAuthor(saved);
    setEditingName(!saved);
    void load(true, k);
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const timer = setInterval(() => {
      void load(false, key);
      setNow(Date.now());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [data, key, load]);

  const post = useCallback((message: Record<string, unknown>) => {
    // The framed page has no origin of its own (it's sandboxed), so "*" is the only target that reaches it. Only
    // pin positions are sent, never comment text or names.
    frameRef.current?.contentWindow?.postMessage({ ...message, mayfly: "feedback" }, "*");
  }, []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const sha = data?.preview.sha ?? "";
  const pins = useMemo(() => pinsFor(items, framePath, sha), [items, framePath, sha]);

  // Keep the frame's pins in step with the list.
  useEffect(() => {
    post({ type: "pins", pins, active, keepDraft: Boolean(draft) });
  }, [pins, active, draft, post]);

  useEffect(() => {
    post({ type: "mode", on: mode });
  }, [mode, post]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = event.data as Record<string, unknown> | null;
      if (!message || message.mayfly !== "feedback") return;
      if (message.type === "ready") {
        const path = cleanFramePath(message.path);
        if (!path) return;
        setFramePath(path);
        setMode(false);
        const id = pendingFocus.current;
        if (id) {
          pendingFocus.current = null;
          // Give the pins a moment to be drawn first.
          setTimeout(() => post({ type: "focus", id }), 150);
        }
      } else if (message.type === "area") {
        const path = cleanFramePath(message.path) ?? framePath ?? "/";
        const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
        setDraft({ x: num(message.x), y: num(message.y), w: num(message.w), h: num(message.h), viewportWidth: num(message.viewportWidth), path });
        setMode(false);
        setFormError(null);
        setSheetOpen(true);
        setTimeout(() => textRef.current?.focus(), 50);
      } else if (message.type === "cancel") {
        setMode(false);
      } else if (message.type === "pick" && typeof message.id === "string") {
        setActive(message.id);
        setSheetOpen(true);
        setTimeout(() => document.getElementById(`rv-c-${message.id as string}`)?.scrollIntoView({ block: "nearest" }), 50);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [framePath, post]);

  // C starts a comment, Escape stops (when not typing).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "Escape") {
        if (mode) setMode(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "c" || event.key === "C") {
        event.preventDefault();
        if (framePath) setMode((on) => !on);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, framePath]);

  function cancelDraft() {
    setDraft(null);
    setText("");
    setFormError(null);
    post({ type: "clear-draft" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const who = author.trim();
    if (!who) {
      setEditingName(true);
      setFormError("Add your name, so the team knows who left the comment.");
      return;
    }
    if (!text.trim()) {
      setFormError("Write what needs changing.");
      textRef.current?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch(api, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ author: who, body: text, ...draft }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; item?: FeedbackItem };
      if (!response.ok || !body.ok || !body.item) throw new Error(body.error || "The comment wasn't posted. Try again.");
      saveName(who);
      setEditingName(false);
      const item = body.item;
      setData((current) => (current ? { ...current, items: [...current.items.filter((entry) => entry.id !== item.id), item] } : current));
      setActive(item.id);
      setTab("page");
      setDraft(null);
      setText("");
      setNow(Date.now());
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "The comment wasn't posted. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function show(item: FeedbackItem) {
    setActive(item.id);
    if (framePath !== null && samePage(item.path, framePath)) {
      post({ type: "focus", id: item.id });
    } else if (data) {
      pendingFocus.current = item.id;
      setFramePath(null);
      setFrameSrc(frameAddress(data.preview.path, item.path));
    }
    if (window.matchMedia("(max-width: 800px)").matches) setSheetOpen(false);
  }

  async function remove(item: FeedbackItem) {
    const response = await fetch(`${api}/${encodeURIComponent(item.id)}`, { method: "DELETE", credentials: "same-origin" });
    if (response.ok) {
      setData((current) => (current ? { ...current, items: current.items.filter((entry) => entry.id !== item.id) } : current));
      if (active === item.id) setActive(null);
    }
  }

  async function copyLink() {
    if (!data?.link) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the feedback link:", data.link);
    }
  }

  if (failure) {
    const signIn = failure.status === 401;
    return (
      <main className="rv-message">
        <div className="rv-message-card">
          <MayflyMark className="rv-message-mark" />
          <h1>{failure.status === 404 ? "No live preview" : signIn ? "This feedback link doesn't work" : "Something went wrong"}</h1>
          <p>{failure.message}</p>
          {signIn ? (
            <Link className="np-primary" href={`/admin/login?next=${encodeURIComponent(`/review/${owner}/${name}/${pr}`)}`}>
              Sign in as an admin
            </Link>
          ) : (
            <Link className="np-secondary" href="/board">
              Go to the board
            </Link>
          )}
        </div>
      </main>
    );
  }

  const list = numbered(items).filter(({ item }) => tab === "all" || (framePath !== null && samePage(item.path, framePath)));
  const onPage = framePath === null ? 0 : items.filter((item) => samePage(item.path, framePath)).length;
  const title = data ? data.preview.title || data.preview.branch : "";

  return (
    <div className="rv" data-mode={mode ? "1" : undefined}>
      <header className="rv-top">
        <Link className="rv-home" href={data?.admin ? "/board" : "/"} aria-label="Mayfly">
          <MayflyMark className="rv-mark" />
        </Link>
        <div className="rv-heading">
          <strong>
            {data ? (
              <>
                <span className="rv-repo">{data.preview.repository} </span>#{data.preview.prNumber}
              </>
            ) : (
              "Loading…"
            )}
          </strong>
          {title ? <span>{title}</span> : null}
        </div>
        <code className="rv-path" title="The page you're looking at">
          {framePath ?? "…"}
        </code>
        <button
          type="button"
          className="rv-comment"
          aria-pressed={mode}
          disabled={!framePath}
          title="Mark a spot on the page and comment (C)"
          onClick={() => {
            if (draft) cancelDraft();
            setMode((on) => !on);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" />
            {mode ? <path d="M9 7.5l6 6M15 7.5l-6 6" /> : <path d="M12 7v6M9 10h6" />}
          </svg>
          {mode ? "Cancel" : "Comment"}
        </button>
        <button type="button" className="rv-list-toggle" aria-expanded={sheetOpen} onClick={() => setSheetOpen((open) => !open)}>
          Comments <span>{items.length}</span>
        </button>
      </header>

      <div className="rv-main">
        <div className="rv-stage">
          {frameSrc ? (
            <iframe
              key={frameSrc}
              ref={frameRef}
              className="rv-frame"
              src={frameSrc}
              title={data ? `Preview of ${data.preview.repository} #${data.preview.prNumber}` : "Preview"}
              onLoad={() => setNow(Date.now())}
            />
          ) : (
            <div className="rv-loading">Loading the preview…</div>
          )}
          {mode ? (
            <p className="rv-mode-note" role="status">
              Drag over the part of the page that needs changing, or tap a spot.
            </p>
          ) : null}
        </div>

        <aside className="rv-side" data-open={sheetOpen ? "1" : undefined} aria-label="Comments">
          <div className="rv-side-head">
            <h2>Comments</h2>
            <button type="button" className="ra-close rv-side-close" aria-label="Close comments" onClick={() => setSheetOpen(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {draft ? (
            <form className="rv-draft" onSubmit={submit} noValidate>
              <div className="rv-draft-head">
                <strong>New comment</strong>
                <code>{draft.path}</code>
              </div>
              <label className="rv-field">
                <span className="visually-hidden">Comment</span>
                <textarea
                  ref={textRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="What should change here?"
                  rows={4}
                  maxLength={1000}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
                    if (event.key === "Escape") cancelDraft();
                  }}
                />
              </label>
              {editingName ? (
                <label className="rv-field">
                  <span>Your name</span>
                  <input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={40} autoComplete="name" placeholder="Shown with your comment" />
                </label>
              ) : (
                <p className="rv-as">
                  Commenting as <strong>{author}</strong>{" "}
                  <button type="button" onClick={() => setEditingName(true)}>
                    Change
                  </button>
                </p>
              )}
              {formError ? (
                <p className="np-error" role="alert">
                  {formError}
                </p>
              ) : null}
              <div className="rv-draft-foot">
                <button type="button" className="np-secondary" disabled={busy} onClick={cancelDraft}>
                  Cancel
                </button>
                <button type="submit" className="np-primary" disabled={busy}>
                  {busy ? "Posting…" : "Post comment"}
                </button>
              </div>
              {data?.postsToGithub ? <p className="rv-note">It&apos;s also posted on the pull request.</p> : null}
            </form>
          ) : null}

          <div className="rv-tabs" role="tablist" aria-label="Which comments">
            <button type="button" role="tab" aria-selected={tab === "page"} onClick={() => setTab("page")}>
              This page <span>{onPage}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>
              All pages <span>{items.length}</span>
            </button>
          </div>

          <ol className="rv-list">
            {list.length === 0 ? (
              <li className="rv-empty">
                {tab === "page" ? "No comments on this page yet." : "No comments yet."} Press <strong>Comment</strong>, then drag over the
                part that needs changing.
              </li>
            ) : (
              [...list].reverse().map(({ item, n }) => {
                const notes = commentNotes(item, { sha, showPage: tab === "all" });
                return (
                  <li key={item.id} id={`rv-c-${item.id}`} className="rv-item" data-on={active === item.id ? "1" : undefined}>
                    <button type="button" className="rv-item-main" onClick={() => show(item)}>
                      <span className="rv-pin" data-old={item.sha !== sha ? "1" : undefined} aria-hidden="true">
                        {n}
                      </span>
                      <span className="rv-item-text">
                        <span className="rv-item-who">
                          <strong>{item.author}</strong>
                          <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                            {formatAgoRounded(item.at, now)}
                          </time>
                        </span>
                        <span className="rv-item-body">{item.body}</span>
                        {notes.length ? <span className="rv-item-notes">{notes.join(" · ")}</span> : null}
                      </span>
                    </button>
                    {data?.admin ? (
                      <button type="button" className="rv-delete" onClick={() => void remove(item)} aria-label={`Delete comment ${n}`}>
                        Delete
                      </button>
                    ) : null}
                  </li>
                );
              })
            )}
          </ol>

          {data?.admin && data.link ? (
            <div className="rv-share">
              <p>Anyone with the feedback link can comment on this preview. It&apos;s also on the pull request.</p>
              <button type="button" className="np-secondary" onClick={() => void copyLink()}>
                {copied ? "Copied" : "Copy feedback link"}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
