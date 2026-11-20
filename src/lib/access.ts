import { checkAdmin, type AdminRequestView } from "./admin";
import { USER_COOKIE, userFromSession } from "./users";

/**
 * Who is making a request:
 *   admin  - MAYFLY_ADMIN_TOKEN (header or admin cookie). Can do everything.
 *   user   - a signed-in, approved team account. Can view everything and manage previews (sleep, extend, keep
 *            awake), but not remove them, change lifetime rules, use backups, run the simulator or manage accounts.
 *   null   - nobody signed in; the public view.
 */
export type Actor = { role: "admin"; name: "admin" } | { role: "user"; name: string; id: string };

function cookieValue(header: AdminRequestView["header"], name: string) {
  for (const part of (header("cookie") ?? "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq !== -1 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

/** Same rule as the admin cookie: anything that changes things must come from this site's own pages. */
function sameOrigin(header: AdminRequestView["header"]) {
  const origin = header("origin");
  const host = (header("host") ?? "").toLowerCase();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export async function whoIs(view: AdminRequestView): Promise<Actor | null> {
  if (checkAdmin(view) === null) return { role: "admin", name: "admin" };
  const value = cookieValue(view.header, USER_COOKIE);
  if (!value) return null;
  const user = await userFromSession(value);
  if (!user) return null;
  if (view.method !== "GET" && view.method !== "HEAD" && !sameOrigin(view.header)) return null;
  return { role: "user", name: user.username, id: user.id };
}

/** For actions team members may take. Returns the actor, or the status and body to refuse with. */
export async function requireMember(
  view: AdminRequestView,
): Promise<{ actor: Actor } | { status: number; body: Record<string, unknown> }> {
  const actor = await whoIs(view);
  if (actor) return { actor };
  const adminDenied = checkAdmin(view);
  // Keep the admin check's own answer (for example "Origin does not match") when an admin cookie was sent.
  if (adminDenied && adminDenied.status === 403) return adminDenied;
  return { status: 401, body: { ok: false, code: "unauthorized", error: "Sign in to do that." } };
}

export function headerOf(req: { headers: Record<string, string | string[] | undefined> }) {
  return (name: string): string | null => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
}
