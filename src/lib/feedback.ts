import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { reviewPath } from "./review";

/**
 * Feedback on a preview: a reviewer opens the preview through Mayfly's review page, drags a box over the part that
 * needs changing and writes a comment. Mayfly keeps the comment on the preview, pins it to that spot and posts it
 * on the pull request.
 *
 * Who may comment: signed-in admins, and anyone with the preview's feedback link. The link carries a key made from
 * the admin token and the preview's id, so it only works for that one preview, stops working when the preview is
 * removed, and every link changes if the admin token is changed. Nothing secret is stored.
 */

export const MAX_FEEDBACK_PER_PREVIEW = 100;
export const MAX_FEEDBACK_BODY = 1000;
export const MAX_AUTHOR = 40;
export const MAX_PATH = 300;

export interface FeedbackItem {
  id: string;
  at: string;
  author: string;
  body: string;
  /** The page inside the preview, e.g. "/checkout?step=2". */
  path: string;
  /** The box the reviewer drew, in page pixels from the top-left of the page (not the screen). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** How wide the reviewer's preview was, since a page can lay out differently at another width. */
  viewportWidth: number;
  /** The commit the preview was on. A newer commit may have moved things. */
  sha: string;
}

/** Read at runtime, like the admin guard, so a changed token applies after a restart. */
function adminToken() {
  return (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
}

/** The key in a preview's feedback link, or null when no admin token is set (feedback is then admin-only and off). */
export function feedbackKey(envId: string, token = adminToken()): string | null {
  if (!token) return null;
  const secret = createHash("sha256").update(`mayfly-feedback:${token}`).digest();
  return createHmac("sha256", secret).update(envId).digest("hex").slice(0, 32);
}

export function feedbackKeyMatches(envId: string, given: string, token = adminToken()) {
  const expected = feedbackKey(envId, token);
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The feedback link to share, or null when feedback is off. */
export function feedbackLink(base: string, env: { id: string; repository: string; prNumber: number }) {
  const key = feedbackKey(env.id);
  if (!key) return null;
  return `${base}${reviewPath(env.repository, env.prNumber)}?key=${key}`;
}

/** Control characters out, spaces tidied. */
function cleanLine(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Keeps line breaks (up to two in a row), drops other control characters. */
function cleanBody(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finite(value: unknown, min: number, max: number) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/** A page path inside the preview: starts with "/", no scheme or host, at most 300 characters. */
export function cleanPath(value: unknown) {
  if (typeof value !== "string") return "/";
  const path = cleanLine(value);
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
}

export type FeedbackInput = Omit<FeedbackItem, "id" | "at" | "sha">;

export function parseFeedback(raw: unknown): { ok: true; input: FeedbackInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Send the comment as JSON." };
  const body = raw as Record<string, unknown>;
  const author = typeof body.author === "string" ? cleanLine(body.author) : "";
  if (!author) return { ok: false, error: "Add your name, so the team knows who left the comment." };
  if (author.length > MAX_AUTHOR) return { ok: false, error: `Keep your name under ${MAX_AUTHOR} characters.` };
  const text = typeof body.body === "string" ? cleanBody(body.body) : "";
  if (!text) return { ok: false, error: "Write what needs changing." };
  if (text.length > MAX_FEEDBACK_BODY) return { ok: false, error: `Keep the comment under ${MAX_FEEDBACK_BODY} characters.` };
  const x = finite(body.x, 0, 100_000);
  const y = finite(body.y, 0, 1_000_000);
  const w = finite(body.w, 0, 100_000);
  const h = finite(body.h, 0, 100_000);
  if (x === null || y === null || w === null || h === null) return { ok: false, error: "Mark the spot on the page first." };
  const viewportWidth = finite(body.viewportWidth, 200, 10_000) ?? 0;
  return { ok: true, input: { author, body: text, path: cleanPath(body.path), x, y, w, h, viewportWidth } };
}

/** Text that goes into a GitHub comment: no @mentions (anyone with the link could ping anyone) and no raw HTML. */
export function githubSafe(text: string) {
  return text.replace(/@/g, "@​").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The note Mayfly posts on the pull request for a new comment. */
export function feedbackNote(item: FeedbackItem, link: string | null) {
  const quoted = githubSafe(item.body)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const page = item.path.replace(/`/g, "'");
  const see = link ? `[See it on the preview](${link}#c-${item.id}) · ` : "";
  return [
    `**Feedback from ${githubSafe(item.author).replace(/[*_`[\]]/g, "")}** on \`${page}\``,
    "",
    quoted,
    "",
    `${see}commit \`${item.sha.slice(0, 8)}\``,
  ].join("\n");
}

/** A short, readable id for a comment. */
export function feedbackId(random: () => string) {
  return random().replace(/-/g, "").slice(0, 10);
}
