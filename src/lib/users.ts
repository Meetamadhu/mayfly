import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { AUDIT_KEEP, type AuditEntry, type AuditRole, type UserRecord } from "./account-records";
import { exclusive, loadState, saveState } from "./store";

/**
 * Team accounts. The admin keeps signing in with MAYFLY_ADMIN_TOKEN; everyone else signs up with a username and
 * password, and can sign in once the admin approves them. Passwords are stored only as scrypt hashes.
 *
 * Sessions are a signed cookie (user id, session version, expiry). The signing key is derived from
 * MAYFLY_ADMIN_TOKEN, so changing the admin token signs every user out too. Disabling a user or signing them out
 * bumps their session version, which ends their sessions straight away.
 */

export const USER_COOKIE = "mayfly_user";
export const USER_SESSION_SECONDS = 12 * 60 * 60;
export const MAX_PENDING = 20;
const RESERVED = new Set(["admin", "administrator", "mayfly", "system", "root", "github", "owner"]);
const USERNAME = /^[a-z0-9][a-z0-9_-]{2,31}$/;

// scrypt cost. 2^15 with r=8 takes ~50 ms and 32 MB, which is plenty for a sign-in form.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 1 << 20) return false;
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length !== KEYLEN) return false;
  const actual = await scryptAsync(password, Buffer.from(parts[4], "base64"), n, r, p);
  return timingSafeEqual(actual, expected);
}

// Checked against when the username doesn't exist, so a wrong username takes as long as a wrong password.
let dummyHash: Promise<string> | null = null;
function dummy() {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/** Lower-cased username, or a plain reason it can't be used. */
export function checkUsername(raw: unknown): { ok: true; username: string } | { ok: false; error: string } {
  const username = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!USERNAME.test(username)) {
    return {
      ok: false,
      error: "Usernames are 3 to 32 letters, numbers, dashes or underscores, starting with a letter or number.",
    };
  }
  if (RESERVED.has(username)) return { ok: false, error: "That username is reserved. Pick another." };
  return { ok: true, username };
}

export function checkPassword(raw: unknown): { ok: true; password: string } | { ok: false; error: string } {
  const password = typeof raw === "string" ? raw : "";
  if (password.length < 10) return { ok: false, error: "Use a password of at least 10 characters." };
  if (password.length > 200) return { ok: false, error: "That password is too long (200 characters at most)." };
  return { ok: true, password };
}

export type PublicUser = Omit<UserRecord, "passwordHash" | "sessionVersion">;
export function publicUser(user: UserRecord): PublicUser {
  const { passwordHash: _hash, sessionVersion: _version, ...rest } = user;
  void _hash;
  void _version;
  return rest;
}

export async function listUsers(): Promise<PublicUser[]> {
  const state = await loadState();
  return (state.users ?? []).map(publicUser);
}

export type SignUpResult =
  | { ok: true; user: PublicUser }
  | { ok: false; code: "invalid" | "taken" | "too_many_pending"; error: string };

export async function signUp(rawUsername: unknown, rawPassword: unknown): Promise<SignUpResult> {
  const name = checkUsername(rawUsername);
  if (!name.ok) return { ok: false, code: "invalid", error: name.error };
  const pass = checkPassword(rawPassword);
  if (!pass.ok) return { ok: false, code: "invalid", error: pass.error };
  // Hash outside the lock: it's the slow part and needs nothing from the state.
  const passwordHash = await hashPassword(pass.password);
  return exclusive(async () => {
    const state = await loadState();
    const users = state.users ?? [];
    if (users.some((user) => user.username === name.username)) {
      return { ok: false, code: "taken", error: "That username is taken. Pick another." } as const;
    }
    if (users.filter((user) => user.status === "pending").length >= MAX_PENDING) {
      return {
        ok: false,
        code: "too_many_pending",
        error: "Too many sign-ups are waiting for approval. Ask the admin to go through them first.",
      } as const;
    }
    const user: UserRecord = {
      id: randomUUID(),
      username: name.username,
      passwordHash,
      status: "pending",
      createdAt: new Date().toISOString(),
      approvedAt: null,
      lastSignInAt: null,
      sessionVersion: 0,
    };
    state.users = [...users, user];
    await saveState(state);
    return { ok: true, user: publicUser(user) } as const;
  });
}

export type SignInResult =
  | { ok: true; user: UserRecord; cookie: string }
  | { ok: false; code: "wrong" | "pending" | "disabled"; error: string };

export async function signInUser(rawUsername: unknown, rawPassword: unknown, now = Date.now()): Promise<SignInResult> {
  const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  const wrong = { ok: false, code: "wrong", error: "Wrong username or password." } as const;
  const found = (await loadState()).users?.find((user) => user.username === username);
  if (!found || !password || password.length > 200) {
    await verifyPassword(password || "x", await dummy());
    return wrong;
  }
  if (!(await verifyPassword(password, found.passwordHash))) return wrong;
  // Only say "waiting" or "disabled" to someone who knows the password.
  if (found.status === "pending") {
    return { ok: false, code: "pending", error: "Your account is waiting for the admin to approve it." };
  }
  if (found.status === "disabled") {
    return { ok: false, code: "disabled", error: "Your account has been turned off. Ask the admin." };
  }
  const user = await exclusive(async () => {
    const state = await loadState();
    const current = state.users?.find((item) => item.id === found.id);
    if (!current || current.status !== "active") return null;
    current.lastSignInAt = new Date(now).toISOString();
    await saveState(state);
    return current;
  });
  if (!user) return wrong;
  return { ok: true, user, cookie: issueUserSession(user, now) };
}

function adminToken() {
  return (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
}

function sessionKey() {
  return createHash("sha256").update(`mayfly-user-session:${adminToken()}`).digest();
}

function sessionMac(payload: string) {
  return createHmac("sha256", sessionKey()).update(payload).digest("hex");
}

export function issueUserSession(user: Pick<UserRecord, "id" | "sessionVersion">, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + USER_SESSION_SECONDS;
  const payload = `${user.id}.${user.sessionVersion}.${expiry}`;
  return `${payload}.${sessionMac(payload)}`;
}

/** The parts of a session cookie whose signature and expiry check out, before looking the user up. */
export function readUserSession(value: string, now = Date.now()) {
  if (!adminToken()) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [id, version, expiry, mac] = parts;
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{1,9}$/.test(version) || !/^\d{1,12}$/.test(expiry)) return null;
  const expected = Buffer.from(sessionMac(`${id}.${version}.${expiry}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(expiry) * 1000 <= now) return null;
  return { id, version: Number(version) };
}

/** The signed-in, approved user for a cookie value, or null. Reads the saved state, so disabling takes effect at once. */
export async function userFromSession(value: string, now = Date.now()): Promise<UserRecord | null> {
  const session = readUserSession(value, now);
  if (!session) return null;
  const user = (await loadState()).users?.find((item) => item.id === session.id);
  if (!user || user.status !== "active" || user.sessionVersion !== session.version) return null;
  return user;
}

export function userCookie(value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${USER_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export type UserAction = "approve" | "disable" | "enable" | "remove" | "signout";

/** Admin actions on an account. Disable, remove and sign out end that user's sessions straight away. */
export async function changeUser(id: string, action: UserAction) {
  return exclusive(async () => {
    const state = await loadState();
    const users = state.users ?? [];
    const user = users.find((item) => item.id === id);
    if (!user) return { ok: false as const, code: "not_found" as const, error: "No account with that id." };
    if (action === "remove") {
      state.users = users.filter((item) => item.id !== id);
    } else if (action === "approve" || action === "enable") {
      if (action === "approve" && user.status !== "pending") {
        return { ok: false as const, code: "invalid" as const, error: "That account isn't waiting for approval." };
      }
      if (action === "enable" && user.status !== "disabled") {
        return { ok: false as const, code: "invalid" as const, error: "That account isn't turned off." };
      }
      user.status = "active";
      user.approvedAt ??= new Date().toISOString();
    } else if (action === "disable") {
      user.status = "disabled";
      user.sessionVersion += 1;
    } else {
      user.sessionVersion += 1;
    }
    await saveState(state);
    return { ok: true as const, user: publicUser(user) };
  });
}

/** Add to the activity log. Never throws: a failed log write must not undo the action it describes. */
export async function recordAudit(
  actor: { name: string; role: AuditRole },
  action: string,
  target: string | null = null,
  detail: string | null = null,
) {
  try {
    await exclusive(async () => {
      const state = await loadState();
      const entry: AuditEntry = { at: new Date().toISOString(), actor: actor.name, role: actor.role, action, target, detail };
      state.audit = [...(state.audit ?? []), entry].slice(-AUDIT_KEEP);
      await saveState(state);
    });
  } catch (error) {
    console.error("Couldn't write to the activity log", error);
  }
}

/** Newest first. */
export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const audit = (await loadState()).audit ?? [];
  return audit.slice(-limit).reverse();
}
