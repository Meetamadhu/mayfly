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

export type AdminRequestView = {
  method: string;
  header(name: string): string | null;
};

function presentedToken(header: AdminRequestView["header"]) {
  const auth = header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return header("x-mayfly-admin")?.trim() ?? "";
}

function sessionKey(token: string) {
  return createHash("sha256").update(`mayfly-session:${token}`).digest();
}

function cookieValue(header: AdminRequestView["header"], name: string) {
  const raw = header("cookie") ?? "";
  for (const part of raw.split(";")) {
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

function originMatchesHost(header: AdminRequestView["header"]) {
  const origin = header("origin");
  if (!origin) return false;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = (header("host") ?? "").toLowerCase();
  if (!host) return false;
  return originHost.toLowerCase() === host;
}

export function sessionCookie(value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  // Lax so a top-level click from a sandboxed preview (opaque origin) still sends the cookie
  // and lands on /admin, not /admin/login. Non-GET admin actions still require a matching Origin.
  return `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export const SESSION_MAX_AGE = SESSION_SECONDS;

/**
 * Framework-free admin guard. One implementation for Express and Next.
 * Accepts MAYFLY_ADMIN_TOKEN as Authorization Bearer or x-mayfly-admin, or a valid mayfly_admin cookie.
 * Cookie-authenticated non-GET requests must send Origin matching Host.
 * Returns null when allowed, or a status + JSON body to send. Never echoes the token.
 */
export function checkAdmin(input: AdminRequestView): null | { status: number; body: Record<string, unknown> } {
  const expected = configuredToken();
  if (!expected) {
    return { status: 401, body: { ok: false, code: "unauthorized", error: "MAYFLY_ADMIN_TOKEN is not configured." } };
  }
  const given = presentedToken(input.header);
  if (given && sameToken(given, expected)) return null;

  const cookie = cookieValue(input.header, ADMIN_COOKIE);
  if (cookie && sessionIsValid(cookie, expected)) {
    if (input.method !== "GET" && !originMatchesHost(input.header)) {
      return { status: 403, body: { ok: false, code: "forbidden", error: "Origin does not match this host." } };
    }
    return null;
  }
  return { status: 401, body: { ok: false, code: "unauthorized", error: "Admin token required." } };
}

/**
 * Next.js adapter used by /api/events until step 3. Delegates to checkAdmin — no second copy of the rules.
 */
export function requireAdmin(request: Request): Response | null {
  const denied = checkAdmin({
    method: request.method,
    header: (name) => request.headers.get(name),
  });
  if (!denied) return null;
  return json(denied.body, denied.status);
}

/** Shared delay before refusing a wrong sign-in (timing pad). */
export async function delayWrongSignIn() {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function rejectSignIn() {
  await delayWrongSignIn();
  return json({ ok: false, code: "unauthorized", error: "Wrong token." }, 401);
}

export function signIn(token: string) {
  const expected = configuredToken();
  if (!expected || !token || !sameToken(token, expected)) return null;
  return issueSessionValue(expected);
}
