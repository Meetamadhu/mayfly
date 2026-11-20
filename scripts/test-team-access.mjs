/**
 * Team accounts against the real server: sign up, wait for approval, sign in, what a team member can and can't
 * do, cross-site requests, the activity log, turning an account off, rate limits and page access.
 * Expects dist/server.js built. Run: node scripts/test-team-access.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 13021;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = randomBytes(32).toString("hex");
const ORIGIN = { origin: BASE };
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function req(method, url, { cookie, headers = {}, body, admin } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, headers: response.headers };
}

const userCookieFrom = (res) => /mayfly_user=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

await mkdir(path.join(root, "data"), { recursive: true });
await writeFile(path.join(root, "data", "state.json"), '{"environments":[]}\n');
await writeFile(path.join(root, "data", "deployments.json"), '{"deployments":[]}\n');

const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    MONGODB_URI: " ",
    MAYFLY_ADMIN_TOKEN: ADMIN,
    DEPLOYER: "fake",
    PREVIEW_FAKE_DELAY_MS: "0",
    PREVIEW_RUNTIME: "process",
    PREVIEW_BASE_URL: BASE,
    ALLOW_SIMULATOR: "true",
    DEMO_PREVIEW: "",
    GITHUB_TOKEN: "",
    GITHUB_WEBHOOK_SECRET: "x",
    ALERT_WEBHOOK_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (c) => (log += c));
child.stderr.on("data", (c) => (log += c));

try {
  for (let i = 0; i < 60; i += 1) {
    if (/Mayfly ready/.test(log)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(/Mayfly ready/.test(log), `server didn't start:\n${log}`);

  // Sign up
  let res = await req("POST", "/api/users/signup", { body: { username: "User1", password: "user1-password" } });
  assert(res.status === 200 && res.json.status === "pending", `signup: ${res.status} ${JSON.stringify(res.json)}`);
  res = await req("POST", "/api/users/signup", { body: { username: "u", password: "user1-password" } });
  assert(res.status === 400, `bad username should be 400, got ${res.status}`);
  res = await req("POST", "/api/users/signup", { body: { username: "user1", password: "user1-password" } });
  assert(res.status === 409, `taken username should be 409, got ${res.status}`);

  // Not yet approved
  res = await req("POST", "/api/users/session", { body: { username: "user1", password: "user1-password" } });
  assert(res.status === 403 && res.json.code === "pending", `waiting account should get 403 pending, got ${res.status}`);
  assert(!userCookieFrom(res), "no session cookie before approval");

  // Admin approves
  res = await req("GET", "/api/admin/users", { admin: true });
  const user1 = res.json.users.find((u) => u.username === "user1");
  assert(user1 && !JSON.stringify(res.json).includes("scrypt"), "admin list has the user and no password hash");
  res = await req("POST", `/api/admin/users/${user1.id}?action=approve`, { admin: true });
  assert(res.status === 200 && res.json.user.status === "active", "approve works");

  // Sign in
  res = await req("POST", "/api/users/session", { body: { username: "USER1", password: "user1-password" } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert(res.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), `sign-in sets a safe cookie: ${setCookie}`);
  let cookie = `mayfly_user=${userCookieFrom(res)}`;
  res = await req("GET", "/api/session", { cookie });
  assert(res.json.role === "user" && res.json.name === "user1", `session says user1: ${JSON.stringify(res.json)}`);
  res = await req("GET", "/api/session");
  assert(res.json.role === null, "no cookie, no session");

  // A preview to act on (admin uses the simulator)
  res = await req("POST", "/api/events", {
    admin: true,
    body: { action: "opened", repository: "acme/web", prNumber: 5, branch: "feat", sha: "c".repeat(40), wait: true },
  });
  assert(res.json?.ok, `simulator opened a preview: ${JSON.stringify(res.json)}`);
  const envId = res.json.environment.id;

  // What a team member can do
  res = await req("POST", `/api/environments/${envId}?action=extend&hours=2`, { cookie, headers: ORIGIN });
  assert(res.status === 200, `member can extend: ${res.status} ${JSON.stringify(res.json)}`);
  // (keep_awake needs a real preview process; the fake deployer has none, so mark it in use instead.)
  res = await req("POST", `/api/environments/${envId}?action=activity`, { cookie, headers: ORIGIN });
  assert(res.status === 200, `member can mark a preview in use: ${res.status}`);

  // Cross-site: same cookie, no or foreign Origin
  res = await req("POST", `/api/environments/${envId}?action=extend&hours=2`, { cookie });
  assert(res.status === 401, `no Origin is refused: ${res.status}`);
  res = await req("POST", `/api/environments/${envId}?action=extend&hours=2`, { cookie, headers: { origin: "https://evil.example" } });
  assert(res.status === 401, `foreign Origin is refused: ${res.status}`);

  // What only the admin can do
  res = await req("POST", `/api/environments/${envId}?action=destroy`, { cookie, headers: ORIGIN });
  assert(res.status === 403 && /Only the admin/.test(res.json.error), `member can't remove: ${res.status} ${JSON.stringify(res.json)}`);
  for (const [method, url, body] of [
    ["POST", "/api/events", { action: "opened", repository: "acme/web", prNumber: 6, branch: "b", sha: "d".repeat(40) }],
    ["GET", "/api/admin/backups"],
    ["POST", "/api/admin/backups"],
    ["GET", "/api/admin/users"],
    ["POST", `/api/admin/users/${user1.id}?action=disable`],
    ["GET", "/api/admin/policy"],
    ["POST", "/api/reaper"],
  ]) {
    res = await req(method, url, { cookie, headers: ORIGIN, body });
    assert(res.status === 401 || res.status === 403, `member refused ${method} ${url}: got ${res.status}`);
  }

  // Full view for members, trimmed for the public
  res = await req("GET", "/api/environments", { cookie });
  const memberEnv = res.json.environments.find((e) => e.id === envId);
  assert(memberEnv.comments.length > 0, "member sees PR comments");
  res = await req("GET", "/api/environments");
  const publicEnv = res.json.environments.find((e) => e.id === envId);
  assert(!publicEnv.comments || publicEnv.comments.length === 0, "public doesn't see PR comments");
  assert(!JSON.stringify(res.json).includes("scrypt"), "no password hashes in any overview");

  // Activity log
  res = await req("GET", "/api/audit");
  assert(res.status === 401, `log is for signed-in people: ${res.status}`);
  res = await req("GET", "/api/audit", { cookie });
  const said = res.json.entries.map((e) => `${e.actor} ${e.action} ${e.target ?? ""} ${e.detail ?? ""}`.trim());
  for (const expected of ["user1 preview.extend acme/web #5 by 2 h", "user1 preview.mark_active acme/web #5", "admin user.approve user1", "user1 signin"]) {
    assert(said.includes(expected), `log has "${expected}": ${JSON.stringify(said)}`);
  }
  assert(!said.some((s) => s.includes("preview.remove")), "the refused removal wasn't logged");

  // Pages
  res = await req("GET", "/admin", { cookie });
  assert(res.status === 200, `member can open /admin: ${res.status}`);
  res = await req("GET", "/pr-comments", { cookie });
  assert(res.status === 200, `member can open /pr-comments: ${res.status}`);
  res = await req("GET", "/policies", { cookie });
  assert([303, 307, 308].includes(res.status) && /\/admin$/.test(res.headers.get("location") ?? ""), `member is sent from /policies to /admin: ${res.status} ${res.headers.get("location")}`);
  res = await req("GET", "/admin");
  assert([303, 307, 308].includes(res.status) && /\/admin\/login/.test(res.headers.get("location") ?? ""), `signed-out /admin goes to sign-in: ${res.status}`);
  res = await req("GET", "/signup");
  assert(res.status === 200, `/signup loads: ${res.status}`);

  // Turning the account off ends the session at once
  res = await req("POST", `/api/admin/users/${user1.id}?action=disable`, { admin: true });
  assert(res.status === 200, "admin can turn the account off");
  res = await req("GET", "/api/session", { cookie });
  assert(res.json.role === null, "turned-off account's cookie no longer works");
  res = await req("POST", `/api/environments/${envId}?action=extend&hours=2`, { cookie, headers: ORIGIN });
  assert(res.status === 401, `turned-off account can't act: ${res.status}`);
  res = await req("POST", "/api/users/session", { body: { username: "user1", password: "user1-password" } });
  assert(res.status === 403 && res.json.code === "disabled", `turned-off account can't sign in: ${res.status}`);

  // Password guessing is slowed and then stopped
  for (let i = 0; i < 8; i += 1) {
    res = await req("POST", "/api/users/session", { body: { username: "user1", password: `guess-${i}-xxxx` } });
    assert(res.status === 401, `wrong password ${i} is 401: ${res.status}`);
  }
  res = await req("POST", "/api/users/session", { body: { username: "user1", password: "user1-password" } });
  assert(res.status === 429, `after 8 wrong tries even the right password waits: ${res.status}`);

  // Sign-up flooding from one address is stopped
  let limited = false;
  for (let i = 0; i < 6 && !limited; i += 1) {
    res = await req("POST", "/api/users/signup", { body: { username: `flood${i}`, password: "flood-password" } });
    limited = res.status === 429;
  }
  assert(limited, "too many sign-ups from one address get 429");

  console.log(`ok: team accounts end to end (${passed} checks)`);
} catch (error) {
  console.error(error.message);
  console.error(log.split("\n").slice(-15).join("\n"));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
