"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { signOutEverywhere } from "@/lib/use-session";
import { cardState, previewHref, statePillLabel } from "@/components/board-parts";
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

/** The small Markdown subset Mayfly writes: **bold**, `code` and [links](https://…). Built as React nodes, never HTML. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) out.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2] !== undefined) out.push(<code key={key}>{match[2]}</code>);
    else {
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

function CommentBody({ body }: { body: string }) {
  const paragraphs = body
    .replace(MARKER, "")
    .trim()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return (
    <div className="prc-body">
      {paragraphs.map((block, index) => (
        <p key={index}>
          {block.split("\n").map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {inline(line, `${index}-${lineIndex}`)}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

function checkState(env: Environment): { label: string; tone: "success" | "pending" | "failure" | "neutral" } {
  if (env.status === "ready") return { label: "Mayfly — Preview ready", tone: "success" };
  if (env.status === "provisioning" || env.status === "updating") return { label: "Mayfly — Building preview…", tone: "pending" };
  if (env.status === "failed") return { label: "Mayfly — Preview failed", tone: "failure" };
  return { label: "Preview removed", tone: "neutral" };
}

function title(env: Environment) {
  return `${env.repository.split("/")[1] ?? env.repository} #${env.prNumber}`;
}

export function PrCommentsPage() {
  const { overview, loadError } = useOverview();
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
    await signOutEverywhere();
    window.location.assign("/admin/login");
  }

  const state = env && env.status !== "destroyed" ? cardState(env) : null;
  const expiresMs = env ? Date.parse(env.expiresAt) : NaN;

  return (
    <AppShell active="comments" githubConnected={Boolean(config?.githubConnected)} onSignOut={signOut}>
      <section className="board-welcome">
        <div>
          <h1>PR comments</h1>
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
            <section className="board-rail-card page-panel prc-thread" aria-label={`Comment on ${title(env)}`}>
              <header className="prc-pr">
                <div className="prc-pr-main">
                  <h2>
                    {env.repository} <span>#{env.prNumber}</span>
                  </h2>
                  <p className="prc-pr-meta mono">
                    {env.branch} · {env.sha.slice(0, 8)}
                  </p>
                </div>
                <a
                  className="btn secondary"
                  href={`https://github.com/${env.repository}/pull/${env.prNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on GitHub
                </a>
              </header>

              <div className="prc-layout">
                <article className="prc-comment">
                  <div className="prc-comment-head">
                    <span className="prc-avatar" aria-hidden="true">
                      M
                    </span>
                    <strong>Mayfly</strong>
                    <span className="prc-bot">bot</span>
                    <span className="prc-when">
                      {latest ? `commented · updated ${formatEventTime(latest.at)}` : "no comment yet"}
                    </span>
                    {latest ? (
                      <button type="button" className="secondary prc-copy" onClick={() => void copy()}>
                        {copied ? "Copied" : "Copy Markdown"}
                      </button>
                    ) : null}
                  </div>
                  {latest ? (
                    <CommentBody body={latest.body} />
                  ) : (
                    <p className="help prc-none">
                      {signedOutView
                        ? "Sign in as an admin to read the comment."
                        : "Mayfly comments once the first build finishes, usually within a minute."}
                    </p>
                  )}
                  {check ? (
                    <div className="prc-check" data-tone={check.tone}>
                      <span className="prc-check-dot" aria-hidden="true" />
                      <span>
                        <strong>Mayfly — Preview</strong> {check.label.replace("Mayfly — ", "· ")}
                      </span>
                    </div>
                  ) : null}
                </article>

                <aside className="prc-facts" aria-label="Preview details">
                  <dl>
                    <div>
                      <dt>State</dt>
                      <dd>
                        {state ? (
                          <span className="state-pill" data-state={state}>
                            {statePillLabel(state)}
                          </span>
                        ) : (
                          removedLabel(env.destroyReason)
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Preview link</dt>
                      <dd>
                        {env.url && state ? (
                          <a href={previewHref(env.url)} target="_blank" rel="noreferrer" className="prc-url">
                            {new URL(env.url).pathname}
                          </a>
                        ) : (
                          "–"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Lifetime</dt>
                      <dd>
                        {!state
                          ? "–"
                          : env.keptByLabel
                            ? `Kept by the “${config?.policy.keepLabel}” label`
                            : Number.isFinite(expiresMs)
                              ? new Date(expiresMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
                              : "–"}
                      </dd>
                    </div>
                    <div>
                      <dt>Sleeps after</dt>
                      <dd>{state && typeof env.sleepSeconds === "number" ? `${env.sleepSeconds} s idle` : "–"}</dd>
                    </div>
                    <div>
                      <dt>Times updated</dt>
                      <dd>{env.comments.length}</dd>
                    </div>
                  </dl>
                </aside>
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
                          <span>{comment.body.replace(MARKER, "").trim().split("\n")[0].replace(/\*\*/g, "")}</span>
                        </li>
                      ))}
                  </ol>
                </details>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
