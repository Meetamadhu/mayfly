import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "./http";

/** Compare as fixed-length digests so neither the token's length nor its content leaks through timing. */
function sameToken(given: string, expected: string) {
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

/**
 * Guard for routes that change or destroy things.
 * The request must present MAYFLY_ADMIN_TOKEN as `Authorization: Bearer <token>` or `x-mayfly-admin`.
 * There is no exception for "local" requests: the Host header is chosen by the sender, so it proves nothing.
 * When MAYFLY_ADMIN_TOKEN is unset, every guarded request is refused.
 * Returns a 401 Response to send, or null when the request may continue. The token is never echoed.
 */
export function requireAdmin(request: Request): Response | null {
  const expected = (process.env.MAYFLY_ADMIN_TOKEN ?? "").trim();
  if (!expected) {
    return json({ ok: false, code: "unauthorized", error: "MAYFLY_ADMIN_TOKEN is not configured." }, 401);
  }
  const given = presentedToken(request);
  if (given && sameToken(given, expected)) return null;
  return json({ ok: false, code: "unauthorized", error: "Admin token required." }, 401);
}
