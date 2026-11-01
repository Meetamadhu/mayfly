import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { json } from "./http";

export const ADMIN_COOKIE = "mayfly_admin";
const SESSION_SECONDS = 8 * 60 * 60;

/** Read at runtime. A static process.env.MAYFLY_ADMIN_TOKEN access is inlined at build, so a restart would keep the old key. */
function configuredToken() {
  return (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
}

/** Compare as fixed-length digests so neither the token's length nor its content leaks through timing. */
export function sameToken(given: string, expected: string) {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  return request.headers.get("x-mayfly-admin")?.trim() ?? "";
}

function sessionKey(token: string) {
  return createHash("sha256").update(`mayfly-session:${token}`).digest();
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

function macFor(expiryEpoch: string, token: string) {
  return createHmac("sha256", sessionKey(token)).update(expiryEpoch).digest("hex");
}

export function issueSessionValue(token: string, nowMs = Date.now()) {
  const expiryEpoch = String(Math.floor(nowMs / 1000) + SESSION_SECONDS);
  return `${expiryEpoch}.${macFor(expiryEpoch, token)}`;
}

export function sessionIsValid(value: string, token: string, nowMs = Date.now()) {
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const expiryEpoch = value.slice(0, dot);
  const presented = value.slice(dot + 1);
  if (!/^[0-9]+$/.test(expiryEpoch)) return false;
  const expectedMac = macFor(expiryEpoch, token);
  const a = Buffer.from(presented);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(expiryEpoch) * 1000 > nowMs;
}

function originMatchesHost(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  return originHost.toLowerCase() === host;
}

export function sessionCookie(value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

export const SESSION_MAX_AGE = SESSION_SECONDS;

/**
 * Guard for routes that change or destroy things.
 * Accepts MAYFLY_ADMIN_TOKEN as `Authorization: Bearer <token>` or `x-mayfly-admin`,
 * or a valid unexpired mayfly_admin cookie.
 * Cookie-authenticated requests that are not GET must send an Origin for this host.
 * When MAYFLY_ADMIN_TOKEN is unset, every guarded request is refused.
 * Returns a 401 or 403 Response to send, or null when the request may continue. The token is never echoed.
 */
export function requireAdmin(request: Request): Response | null {
  const expected = configuredToken();
  if (!expected) {
    return json({ ok: false, code: "unauthorized", error: "MAYFLY_ADMIN_TOKEN is not configured." }, 401);
  }
  const given = presentedToken(request);
  if (given && sameToken(given, expected)) return null;

  const cookie = cookieValue(request, ADMIN_COOKIE);
  if (cookie && sessionIsValid(cookie, expected)) {
    if (request.method !== "GET" && !originMatchesHost(request)) {
      return json({ ok: false, code: "forbidden", error: "Origin does not match this host." }, 403);
    }
    return null;
  }
  return json({ ok: false, code: "unauthorized", error: "Admin token required." }, 401);
}

export async function rejectSignIn() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return json({ ok: false, code: "unauthorized", error: "Wrong token." }, 401);
}

export function signIn(token: string) {
  const expected = configuredToken();
  if (!expected || !token || !sameToken(token, expected)) return null;
  return issueSessionValue(expected);
}
