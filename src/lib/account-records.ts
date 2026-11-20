/**
 * Shapes of the team accounts and the activity log as they're saved with the rest of Mayfly's state, and the
 * checks used when reading them back. Kept apart from users.ts so the stores can import it without a cycle.
 */

export type UserStatus = "pending" | "active" | "disabled";

export interface UserRecord {
  id: string;
  /** Lower-case, 3 to 32 of a-z 0-9 _ -, starting with a letter or digit. */
  username: string;
  /** scrypt$N$r$p$salt$hash (base64). Never sent to a browser. */
  passwordHash: string;
  status: UserStatus;
  createdAt: string;
  approvedAt: string | null;
  lastSignInAt: string | null;
  /** Bumped to sign the user out everywhere (disable, sign out, password change). */
  sessionVersion: number;
}

export type AuditRole = "admin" | "user";

export interface AuditEntry {
  at: string;
  /** "admin" for the token holder, otherwise the username. */
  actor: string;
  role: AuditRole;
  /** Short machine name, e.g. "preview.extend", "user.approve", "signin". */
  action: string;
  /** What it was done to, e.g. "acme/web #12" or a username. */
  target: string | null;
  /** A few words, e.g. "by 4 h". */
  detail: string | null;
}

export const AUDIT_KEEP = 500;

const USERNAME = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const ISO = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function asUsers(value: unknown): UserRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: UserRecord[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    if (typeof u.id !== "string" || !u.id) continue;
    if (typeof u.username !== "string" || !USERNAME.test(u.username) || seen.has(u.username)) continue;
    if (typeof u.passwordHash !== "string" || !u.passwordHash.startsWith("scrypt$")) continue;
    if (u.status !== "pending" && u.status !== "active" && u.status !== "disabled") continue;
    if (!ISO(u.createdAt)) continue;
    seen.add(u.username);
    out.push({
      id: u.id,
      username: u.username,
      passwordHash: u.passwordHash,
      status: u.status,
      createdAt: u.createdAt,
      approvedAt: ISO(u.approvedAt) ? u.approvedAt : null,
      lastSignInAt: ISO(u.lastSignInAt) ? u.lastSignInAt : null,
      sessionVersion: Number.isInteger(u.sessionVersion) && (u.sessionVersion as number) >= 0 ? (u.sessionVersion as number) : 0,
    });
  }
  return out;
}

const text = (value: unknown, max: number) => (typeof value === "string" && value ? value.slice(0, max) : null);

export function asAudit(value: unknown): AuditEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AuditEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (!ISO(e.at) || typeof e.actor !== "string" || !e.actor || typeof e.action !== "string" || !e.action) continue;
    if (e.role !== "admin" && e.role !== "user") continue;
    out.push({
      at: e.at,
      actor: e.actor.slice(0, 40),
      role: e.role,
      action: e.action.slice(0, 40),
      target: text(e.target, 120),
      detail: text(e.detail, 160),
    });
  }
  return out.slice(-AUDIT_KEEP);
}

/** Spread into asState so both stores keep accounts and the log, and leave them out when empty or unreadable. */
export function accountFields(value: { users?: unknown; audit?: unknown }) {
  const users = asUsers(value.users);
  const audit = asAudit(value.audit);
  return { ...(users ? { users } : {}), ...(audit ? { audit } : {}) };
}
