"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { cardState, formatAgo, previewHref, statePillLabel } from "@/components/board-parts";
import { formatEventTime, removedLabel } from "@/lib/timeline";
import { isLiveStatus, type Environment } from "@/lib/types";
import { useOverview } from "@/lib/use-overview";

const MARKER = "<!-- mayfly-preview -->";

/** Only http(s) links become anchors; anything else stays text. */
function safeHref(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The small Markdown subset Mayfly writes: **bold**, `code`, [links](https://…) and bare links. React nodes, never HTML. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s|)]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) out.push(<strong key={key}>{inline(match[1], key)}</strong>);
    else if (match[2] !== undefined) out.push(<code key={key}>{match[2]}</code>);
    else if (match[5] !== undefined) {
      const href = safeHref(match[5]);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {match[5]}
          </a>
        ) : (
          match[5]
        ),
      );
    } else {
      const href = safeHref(match[4]);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {match[3]}
          </a>
        ) : (
          match[0]
        ),
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Split a Markdown table row into cells, keeping escaped pipes (\|) inside a cell. */
function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((part) => part.trim().replace(/\\\|/g, "|"));
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "paragraph"; lines: string[] };

/** The Markdown Mayfly writes, as blocks: ### headings, ``` code, | tables | and paragraphs. */
export function commentBlocks(body: string): Block[] {
  const lines = body.replace(MARKER, "").trim().split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if (/^#{1,6}\s+/.test(trimmed)) {
      flush();
      blocks.push({ kind: "heading", text: trimmed.replace(/^#{1,6}\s+/, "") });
    } else if (trimmed.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(tableCells(lines[i]));
      i -= 1;
      const separator = rows[1]?.every((c) => /^:?-{3,}:?$/.test(c));
      blocks.push(separator ? { kind: "table", header: rows[0], rows: rows.slice(2) } : { kind: "table", header: [], rows });
    } else if (!trimmed) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

function CommentBody({ body }: { body: string }) {
  const blocks = commentBlocks(body);
  return (
    <div className="prc-body">
      {blocks.map((block, index) => {
        if (block.kind === "heading") return <h3 key={index}>{inline(block.text, `h${index}`)}</h3>;
        if (block.kind === "code")
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === "table") {
          const hasHeader = block.header.some(Boolean);
          return (
            <table key={index}>
              {hasHeader ? (
                <thead>
                  <tr>
                    {block.header.map((c, k) => (
                      <th key={k}>{inline(c, `t${index}-h${k}`)}</th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, k) => (
                      <td key={k}>{inline(c, `t${index}-${r}-${k}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        // A paragraph that is only a bold link is the comment's main link: shown as a button.
        const cta = block.lines.length === 1 && /^\*\*\[[^\]]+\]\([^)\s]+\)\*\*$/.test(block.lines[0].trim());
        return (
          <p key={index} className={cta ? "prc-cta" : undefined}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {inline(line, `${index}-${lineIndex}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function checkState(env: Environment): { label: string; status: string; tone: "success" | "pending" | "failure" | "neutral" } {
  if (env.status === "ready") return { label: "Mayfly — Preview ready", status: "Preview ready", tone: "success" };
  if (env.status === "provisioning" || env.status === "updating")
    return { label: "Mayfly — Building preview…", status: "Building", tone: "pending" };
  if (env.status === "failed") return { label: "Mayfly — Preview failed", status: "Build failed", tone: "failure" };
  return { label: "Preview removed", status: "Removed", tone: "neutral" };
}

/** "1 h 55 m remaining", "3 days remaining". */
function remaining(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "ending now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} m remaining`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} m remaining`;
  return `${Math.round(hours / 24)} days remaining`;
}

function title(env: Environment) {
  return `${env.repository.split("/")[1] ?? env.repository} #${env.prNumber}`;
}

export function PrCommentsPage() {
  const { overview, loadError, now } = useOverview();
  const [selectedId, setSelectedId] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const config = overview?.config;
  const demoKey = config?.demo ?? null;

  // Live previews first (newest activity first), then up to 15 recently removed ones that posted a comment.
  const options = useMemo(() => {
    const envs = (overview?.environments ?? []).filter((env) => `${env.repository}#${env.prNumber}` !== demoKey);
    const byUpdate = (a: Environment, b: Environment) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    const live = envs.filter((env) => isLiveStatus(env.status) || env.status === "failed").sort(byUpdate);
    const removed = envs
      .filter((env) => env.status === "destroyed" && env.comments.length > 0)
      .sort(byUpdate)
      .slice(0, 15);
    return { live, removed };
  }, [overview, demoKey]);

  const all = [...options.live, ...options.removed];
  const env = all.find((item) => item.id === selectedId) ?? all[0] ?? null;

  useEffect(() => {
    setCopied(false);
    setHistoryOpen(false);
  }, [env?.id]);

  const latest = env?.comments.at(-1) ?? null;
  const markdown = latest ? `${MARKER}\n${latest.body.replace(MARKER, "").trim()}` : "";
  const check = env ? checkState(env) : null;
  const signedOutView = Boolean(overview && all.length > 0 && all.every((item) => item.comments.length === 0));

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "include" });
    window.location.assign("/admin/login");
  }

  const state = env && env.status !== "destroyed" ? cardState(env) : null;
  const expiresMs = env ? Date.parse(env.expiresAt) : NaN;

  return (
    <AppShell active="comments" githubConnected={Boolean(config?.githubConnected)} onSignOut={signOut}>
      <section className="board-welcome">
        <div>
          <h1 className="title-in-header">PR comments</h1>
          <p className="lede">
            The comment and check Mayfly keeps on each pull request. It edits one comment in place as the preview
            changes, so the PR doesn&apos;t fill up with bot messages.
          </p>
        </div>
      </section>

      {loadError ? (
        <p className="error" role="alert">
          {loadError}
        </p>
      ) : null}
      {!config?.githubConnected && overview ? (
        <p className="policy-flag prc-flag">
          Mayfly isn&apos;t connected to GitHub yet (no token), so these comments are only shown here, not on GitHub.
        </p>
      ) : null}

      {!overview ? (
        <p className="help">Loading…</p>
      ) : all.length === 0 ? (
        <p className="empty">No pull request has a preview yet. Open one on GitHub and its comment will show up here.</p>
      ) : (
        <>
          <div className="prc-picker">
            <label htmlFor="prc-select">Pull request</label>
            <select id="prc-select" value={env?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
              {options.live.length > 0 ? (
                <optgroup label="Live">
                  {options.live.map((item) => (
                    <option key={item.id} value={item.id}>
                      {title(item)} · {item.branch}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {options.removed.length > 0 ? (
                <optgroup label="Removed">
                  {options.removed.map((item) => (
                    <option key={item.id} value={item.id}>
                      {title(item)} · {item.branch} (removed)
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>

          {env ? (
            <section className="prc-card" data-tone={check?.tone} aria-label={`Comment on ${title(env)}`}>
              <header className="prc-card-head">
                <span className="prc-pr-icon" data-tone={check?.tone} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="5.5" r="2.2" />
                    <circle cx="6" cy="18.5" r="2.2" />
                    <circle cx="18" cy="18.5" r="2.2" />
                    <path d="M6 7.7v8.6M18 16.3V10a3 3 0 0 0-3-3h-4M13 4.5 10.5 7 13 9.5" />
                  </svg>
                </span>
                <div className="prc-card-title">
                  <h2>{env.title?.trim() || `${env.repository} #${env.prNumber}`}</h2>
                  <p className="prc-card-meta">
                    {env.title?.trim() ? (
                      <>
                        <strong>#{env.prNumber}</strong>
                        <span>{env.repository}</span>
                      </>
                    ) : null}
                    {env.author ? <span>opened by @{env.author}</span> : null}
                    <code>{env.branch}</code>
                  </p>
                </div>
                <div className="prc-card-actions">
                  {latest ? (
                    <button type="button" className="prc-btn" onClick={() => void copy()}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                        <rect x="8" y="8" width="12" height="12" rx="2" />
                        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                      </svg>
                      {copied ? "Copied" : "Copy Markdown"}
                    </button>
                  ) : null}
                  <a className="prc-btn" href={`https://github.com/${env.repository}/pull/${env.prNumber}`} target="_blank" rel="noreferrer">
                    Open on GitHub
                  </a>
                </div>
              </header>

              <div className="prc-card-body">
                <article className="prc-comment">
                  <div className="prc-comment-head">
                    <span className="prc-avatar" aria-hidden="true">
                      M
                    </span>
                    <strong>mayfly</strong>
                    <span className="prc-bot">bot</span>
                    <span className="prc-when">
                      {latest
                        ? `${env.comments.length > 1 ? "updated" : "commented"} ${formatAgo(latest.at, now)}`
                        : "no comment yet"}
                    </span>
                    {check ? (
                      <span className="prc-status" data-tone={check.tone}>
                        <span className="prc-check-dot" aria-hidden="true" />
                        {check.status}
                      </span>
                    ) : null}
                  </div>
                  <div className="prc-comment-main">
                    {latest ? (
                      <CommentBody body={latest.body} />
                    ) : (
                      <p className="help prc-none">
                        {signedOutView
                          ? "Sign in as an admin to read the comment."
                          : "Mayfly comments once the first build finishes, usually within a minute."}
                      </p>
                    )}
                  </div>
                  {check ? (
                    <div className="prc-check" data-tone={check.tone}>
                      <span className="prc-check-dot" aria-hidden="true" />
                      <span>
                        <strong>Mayfly — Preview</strong> {check.label.replace("Mayfly — ", "· ")}
                      </span>
                    </div>
                  ) : null}
                </article>

                <div className="prc-boxes" aria-label="Preview details">
                  <div className="prc-box">
                    <span className="prc-box-label">Preview link</span>
                    {env.url && state ? (
                      <a href={previewHref(env.url)} target="_blank" rel="noreferrer" className="prc-url">
                        {env.url}
                      </a>
                    ) : (
                      <span>–</span>
                    )}
                  </div>
                  <div className="prc-box">
                    <span className="prc-box-label">Lifetime and sleep</span>
                    <span className="prc-box-value">
                      {!state
                        ? removedLabel(env.destroyReason)
                        : env.keptByLabel
                          ? `Kept by the “${config?.policy.keepLabel}” label`
                          : remaining(expiresMs - now)}
                      {state && typeof env.sleepSeconds === "number" ? (
                        <span className="prc-box-sub"> · sleeps after {env.sleepSeconds} s idle</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="prc-box">
                    <span className="prc-box-label">State</span>
                    {state ? (
                      <span className="state-pill" data-state={state}>
                        {statePillLabel(state)}
                      </span>
                    ) : (
                      <span>Removed</span>
                    )}
                  </div>
                  <div className="prc-box">
                    <span className="prc-box-label">Times updated</span>
                    <span className="prc-box-value">{env.comments.length}</span>
                  </div>
                </div>

                {env.comments.length > 1 ? (
                  <details className="prc-history" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
                    <summary>Earlier versions of this comment ({env.comments.length - 1})</summary>
                    <ol>
                      {env.comments
                        .slice(0, -1)
                        .reverse()
                        .map((comment, index) => (
                          <li key={`${comment.at}-${index}`}>
                            <span className="prc-history-when">{formatEventTime(comment.at)}</span>
                            <span>{comment.body.replace(MARKER, "").trim().split("\n")[0].replace(/\*\*|^#+\s*/g, "")}</span>
                          </li>
                        ))}
                    </ol>
                  </details>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
