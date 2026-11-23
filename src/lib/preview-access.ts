import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { checkAdmin } from "./admin";

/**
 * Optional team password in front of every preview (PREVIEW_PASSWORD). When it's set, opening a preview link asks
 * for the password once; after that a signed cookie lets the browser in for PREVIEW_ACCESS_DAYS (default 7).
 * Signed-in admins never get asked. Changing the password signs everyone out.
 *
 * The cookie is HttpOnly and is removed before requests reach a preview app (see preview-proxy), so a preview's
 * own code can't read or forward it.
 */

export const PREVIEW_ACCESS_COOKIE = "mayfly_preview";

/** Read at runtime, so a changed password applies after a restart without a rebuild. */
export function previewPassword() {
  return (process.env["PREVIEW_PASSWORD"] ?? "").trim();
}

export function previewsProtected() {
  return previewPassword().length > 0;
}

export function accessDays(raw = process.env.PREVIEW_ACCESS_DAYS) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : 7;
}

function key(password: string) {
  return createHash("sha256").update(`mayfly-preview-access:${password}`).digest();
}

function macFor(expiryEpoch: string, password: string) {
  return createHmac("sha256", key(password)).update(expiryEpoch).digest("hex");
}

export function issueAccessValue(password: string, nowMs = Date.now(), days = accessDays()) {
  const expiryEpoch = String(Math.floor(nowMs / 1000) + days * 24 * 60 * 60);
  return `${expiryEpoch}.${macFor(expiryEpoch, password)}`;
}

export function accessValueIsValid(value: string, password: string, nowMs = Date.now()) {
  const dot = value.indexOf(".");
  if (dot < 1 || !password) return false;
  const expiryEpoch = value.slice(0, dot);
  if (!/^[0-9]+$/.test(expiryEpoch)) return false;
  const a = Buffer.from(value.slice(dot + 1));
  const b = Buffer.from(macFor(expiryEpoch, password));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(expiryEpoch) * 1000 > nowMs;
}

/** Compared as digests, so neither length nor content leaks through timing. */
export function passwordMatches(given: string, expected = previewPassword()) {
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

export type AccessRequest = { method: string; headers: Record<string, string | string[] | undefined> };

/** May this request see previews? Always yes without a password; otherwise a valid cookie or an admin. */
export function hasPreviewAccess(req: AccessRequest) {
  const password = previewPassword();
  if (!password) return true;
  const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie.join("; ") : req.headers.cookie;
  if (accessValueIsValid(cookieValue(cookieHeader, PREVIEW_ACCESS_COOKIE), password)) return true;
  const header = (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
  // Admins see previews without the team password; GET is enough here, the preview isn't changed by it.
  return checkAdmin({ method: "GET", header }) === null;
}

export function accessCookie(value: string, maxAgeSeconds: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${PREVIEW_ACCESS_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Only preview paths, so the form can't be used to send someone elsewhere after the password. */
export function safeNext(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  return /^\/p\/[^/\\]+\/[^/\\]+\/\d{1,9}(\/[^\\]*)?$/.test(value) && !value.startsWith("//") ? value : null;
}

// ── Wrong guesses ───────────────────────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRONG = 20;

type Tries = Map<string, { wrong: number; resetAt: number }>;
function tries(): Tries {
  const holder = globalThis as unknown as { __mayflyPreviewTries?: Tries };
  holder.__mayflyPreviewTries ??= new Map();
  return holder.__mayflyPreviewTries;
}

/** True when this address has guessed wrong too often in the last 15 minutes. */
export function tooManyTries(address: string, now = Date.now()) {
  const entry = tries().get(address);
  return Boolean(entry && entry.resetAt > now && entry.wrong >= MAX_WRONG);
}

export function recordWrongTry(address: string, now = Date.now()) {
  const map = tries();
  for (const [key, value] of map) if (value.resetAt <= now) map.delete(key);
  const entry = map.get(address);
  if (entry && entry.resetAt > now) entry.wrong += 1;
  else map.set(address, { wrong: 1, resetAt: now + WINDOW_MS });
}

export function resetTriesForTests() {
  tries().clear();
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────────────

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The password page shown in place of a protected preview. Self-contained: no scripts, no outside files. */
export function passwordPage(options: { repository: string; pr: string; next: string; error?: string }) {
  const { repository, pr, next, error } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Private preview · Mayfly</title>
<style>
  :root { color-scheme: light dark; --bg: #eef4f1; --card: #ffffff; --ink: #0c1a16; --muted: #4a5d56; --line: #d3e0da; --accent: #0f8f6b; --on-accent: #ffffff; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #020618; --card: #0f172b; --ink: #e8f0ec; --muted: #9fb2ab; --line: #24324a; --accent: #3ddbb0; --on-accent: #032019; --error: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: min(420px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 28px 24px; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 20px; }
  .brand svg { width: 38px; height: auto; }
  h1 { font-size: 1.45rem; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 20px; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; color: var(--ink); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; min-height: 48px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--ink); font: inherit; }
  input:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; min-height: 50px; margin-top: 14px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 700; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
  .error { color: var(--error); margin: 12px 0 0; font-weight: 600; }
  .foot { margin: 18px 0 0; font-size: 0.88rem; }
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg viewBox="84 66 362 362" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M304 103 H210 A103 103 0 0 0 107 206 V305 A103 103 0 0 0 210 408 H309 A103 103 0 0 0 412 305 V207" stroke-width="34"/><path d="M178.5 216.5 V295.5 M178.5 256.5 A40 40 0 0 1 258.5 256.5 V295.5 M258.5 256.5 A40 40 0 0 1 338.5 256.5 V295.5" stroke-width="39"/></g><g fill="#3ddbb0"><circle cx="362.5" cy="145.5" r="25"/><circle cx="395.5" cy="113.5" r="11" opacity=".78"/><circle cx="415" cy="95" r="8.5" opacity=".55"/><circle cx="429.5" cy="80.5" r="6" opacity=".38"/></g></svg>
    Mayfly
  </div>
  <h1>This preview is private</h1>
  <p>Enter the team password to see PR #${escapeHtml(pr)} of <code>${escapeHtml(repository)}</code>.</p>
  <form method="post" action="/api/preview-access">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="password">Team password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">View preview</button>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  </form>
  <p class="foot">Don&#39;t have it? Ask whoever shared this link.</p>
</main>
</body>
</html>`;
}
