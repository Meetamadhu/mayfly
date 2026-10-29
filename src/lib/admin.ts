import { timingSafeEqual } from "node:crypto";
import { json } from "./http";

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  return request.headers.get("x-mayfly-admin")?.trim() ?? "";
}

function loopbackHost(request: Request) {
  const raw = (request.headers.get("host") ?? "").trim().toLowerCase();
  // Strip the port. IPv6 literals are not accepted, so a bare colon split is enough.
  const host = raw.startsWith("[") ? raw : raw.split(":")[0];
  return host === "localhost" || host === "127.0.0.1";
}

/**
 * Guard for routes that change or destroy things.
 * - MAYFLY_ADMIN_TOKEN set: the request must present it as `Authorization: Bearer <token>` or `x-mayfly-admin`.
 * - MAYFLY_ADMIN_TOKEN unset: only requests whose Host is localhost or 127.0.0.1 are allowed.
 * Returns a 401 Response to send, or null when the request may continue. The token is never echoed.
 */
export function requireAdmin(request: Request): Response | null {
  const expected = (process.env.MAYFLY_ADMIN_TOKEN ?? "").trim();
  if (expected) {
    const given = presentedToken(request);
    if (given && sameToken(given, expected)) return null;
    return json({ ok: false, code: "unauthorized", error: "Admin token required." }, 401);
  }
  if (loopbackHost(request)) return null;
  return json(
    { ok: false, code: "unauthorized", error: "Set MAYFLY_ADMIN_TOKEN to use this endpoint from a non-local host." },
    401,
  );
}
