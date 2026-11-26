/**
 * Demo pricing end to end, against a mock GitHub API and signed webhooks: reading the plans, the demo checkout
 * (admins only), the Free plan's limits on previews, repositories and sizes (with a note on the pull request),
 * upgrading lifting them, running previews surviving a downgrade, and the plan surviving a restart.
 * Run: npm run build && node scripts/test-plans.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and ports 13030/18786. Run it on a dev machine, not where
 * Mayfly is live. MONGODB_URI is ignored, so it never touches the real database.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(root, "data", "state.json");
const MOCK_PORT = 18786;
const PORT = 13030;
const BASE = `http://127.0.0.1:${PORT}`;
const GH_TOKEN = randomBytes(12).toString("hex");
const ADMIN = randomBytes(32).toString("hex");
const SECRET = randomBytes(16).toString("hex");

let passed = 0;
function check(cond, message, detail) {
  if (!cond) throw new Error(`FAIL: ${message}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  passed += 1;
  console.log(`ok  ${message}`);
}

// ---- mock GitHub ----
const posted = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url || "/", "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!(req.headers.authorization || "").includes(GH_TOKEN)) return send(401, { message: "Bad credentials" });
    if (req.method === "GET" && url.pathname === "/user") return send(200, { login: "mayfly-bot" });
    const pull = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && pull) return send(200, { number: Number(pull[1]), head: { sha: "c".repeat(40), ref: `feat/${pull[1]}` } });
    if (req.method === "GET" && /\/issues\/\d+\/comments$/.test(url.pathname)) return send(200, []);
    const issue = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (req.method === "POST" && issue) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      posted.push({ repo: issue[1], pr: Number(issue[2]), body: String(body.body ?? "") });
      return send(201, { id: posted.length + 100 });
    }
    if (req.method === "PATCH") return send(200, {});
    if (req.method === "POST" && url.pathname.includes("/statuses/")) return send(201, {});
    send(404, { message: `mock miss ${req.method} ${url.pathname}` });
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

// ---- Mayfly ----
let log = "";
let mayfly = null;
async function startMayfly() {
  log = "";
  mayfly = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: " ",
      PREVIEW_RUNTIME: "process",
      PREVIEW_BASE_URL: BASE,
      DEMO_PREVIEW: "",
      PREVIEW_REPOS: "",
      REAPER_INTERVAL_MS: "1000",
      MAYFLY_ADMIN_TOKEN: ADMIN,
      GITHUB_TOKEN: GH_TOKEN,
      GITHUB_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_WEBHOOK_SECRET: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mayfly.stdout.on("data", (c) => (log += c));
  mayfly.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100; i += 1) {
    if (/Mayfly ready/.test(log)) return;
    if (mayfly.exitCode != null) throw new Error(`Mayfly exited:\n${log}`);
    await sleep(100);
  }
  throw new Error(`Mayfly did not start:\n${log}`);
}
async function stopMayfly() {
  if (!mayfly || mayfly.exitCode != null) return;
  const exited = new Promise((resolve) => mayfly.once("exit", resolve));
  mayfly.kill("SIGTERM");
  await exited;
}

const admin = { authorization: `Bearer ${ADMIN}`, origin: BASE };
async function api(method, url, body, headers = admin) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
async function webhook(action, repo, pr) {
  const payload = JSON.stringify({
    action,
    repository: { full_name: repo },
    pull_request: { number: pr, merged: false, labels: [], user: { login: `dev${pr}` }, head: { sha: "a".repeat(40), ref: `feature/${pr}`, repo: { full_name: repo } } },
  });
  const res = await fetch(`${BASE}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function live(repo, pr) {
  const { json } = await api("GET", "/api/environments");
  return json.environments.find((e) => e.repository === repo && e.prNumber === pr && e.status !== "destroyed");
}
async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}\n${log.slice(-2000)}`);
}
const ready = (repo, pr) => waitFor(async () => (await live(repo, pr))?.status === "ready", `${repo}#${pr} to be ready`);
async function close(repo, pr) {
  await webhook("closed", repo, pr);
  await waitFor(async () => !(await live(repo, pr)), `${repo}#${pr} to be removed`);
}
const setPlan = (plan, headers) => api("POST", "/api/plan", { plan }, headers);

await rm(path.join(root, "data"), { recursive: true, force: true });
try {
  await startMayfly();

  // ---- reading the plans ----
  const first = await api("GET", "/api/plan", undefined, {});
  check(first.status === 200 && first.json.current.id === "team" && first.json.current.chosen === false, "anyone can read the plans; a new install is on Team", first.json?.current);
  check(first.json.plans.map((p) => `${p.id}:${p.price}`).join() === "free:0,team:999,business:2999", "three plans, priced in rupees", first.json.plans);
  check(first.json.demo === true && first.json.usage.previews === 0, "it says it's a demo and nothing is running");
  const page = await fetch(`${BASE}/pricing`);
  check(page.status === 200 && (await page.text()).includes("Pricing"), "the Pricing page loads");

  // ---- the demo checkout is for admins only ----
  check((await setPlan("free", { origin: BASE })).status === 401, "changing plan needs an admin");
  check((await setPlan("gold")).status === 400, "an unknown plan is refused");
  const free = await setPlan("free");
  check(free.status === 200 && free.json.current.id === "free" && free.json.current.chosen, "an admin changes to Free", free.json?.current);
  const saved = JSON.parse(await readFile(stateFile, "utf8")).plan;
  check(saved?.id === "free" && saved.demo === true && !Number.isNaN(Date.parse(saved.since)), "the plan is saved, marked as a demo", saved);

  // ---- Free: 3 previews at a time ----
  for (const pr of [1, 2, 3]) {
    const opened = await webhook("opened", "acme/web", pr);
    check(opened.status < 300, `preview ${pr} of 3 starts`, opened);
    await ready("acme/web", pr);
  }
  const fourth = await webhook("opened", "acme/web", 4);
  check(!(await live("acme/web", 4)), "a fourth preview doesn't start on Free", fourth);
  const note = await waitFor(() => posted.find((c) => c.pr === 4 && c.body.includes("Mayfly preview not started")), "the note on PR 4");
  check(/Free plan runs 3 previews at a time, and 3 are running/.test(note.body) && note.body.includes(`${BASE}/pricing`), "the pull request says why, with a link to the plans", note.body);
  check((await api("GET", "/api/plan", undefined, {})).json.usage.previews === 3, "usage shows 3 running");

  // ---- Free: 1 repository ----
  await close("acme/web", 3);
  await webhook("opened", "acme/api", 10);
  check(!(await live("acme/api", 10)), "a second repository doesn't start on Free");
  const repoNote = await waitFor(() => posted.find((c) => c.repo === "acme/api" && c.pr === 10), "the note on acme/api 10");
  check(/covers 1 repository at a time, and previews are running for acme\/web/.test(repoNote.body), "and the pull request says why", repoNote.body);

  // ---- Free: sizes ----
  const sizeSaved = await api("PUT", "/api/preview-settings/acme/web", { size: "large", vars: [] });
  check(sizeSaved.status === 200, "the repository's previews are set to Large", sizeSaved.json);
  await webhook("opened", "acme/web", 5);
  const fallback = await ready("acme/web", 5).then(() => live("acme/web", 5));
  check(!fallback.size, "on Free, the repository's Large falls back to Standard instead of failing", fallback);
  await close("acme/web", 5);
  const large = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/7", prNumber: 7, size: "large" });
  check(large.status === 409 && large.json.code === "plan_cap" && /Large previews aren't part of the Free plan/.test(large.json.error), "a Large preview picked by hand is refused on Free", large.json);

  // ---- upgrading lifts the limits ----
  check((await setPlan("team")).json.current.id === "team", "upgrade to Team");
  const largeNow = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/7", prNumber: 7, size: "large" });
  check(largeNow.status === 200 && largeNow.json.environment.size === "large", "a Large preview starts on Team", largeNow.json);
  await webhook("opened", "acme/api", 10);
  await ready("acme/api", 10);
  check(true, "the second repository starts on Team");
  const usage = (await api("GET", "/api/plan", undefined, {})).json.usage;
  check(usage.previews === 4 && usage.repositories === 2, "usage counts 4 previews in 2 repositories", usage);

  // ---- downgrading never stops what's running ----
  check((await setPlan("free")).status === 200, "an admin can move back to Free while over its limits");
  const still = (await api("GET", "/api/environments")).json.environments.filter((e) => e.status !== "destroyed").length;
  check(still === 4, "all 4 previews keep running", still);
  await webhook("opened", "acme/web", 11);
  check(!(await live("acme/web", 11)), "but a new one waits until there's room");
  const pushed = await webhook("synchronize", "acme/web", 1);
  check(pushed.status < 300 && (await live("acme/web", 1)), "a new commit on a running preview still updates it", pushed);

  // ---- the plan survives a restart ----
  await stopMayfly();
  await startMayfly();
  check((await api("GET", "/api/plan", undefined, {})).json.current.id === "free", "the plan is still Free after a restart");

  for (const [repo, pr] of [["acme/web", 1], ["acme/web", 2], ["acme/web", 7], ["acme/api", 10]]) await close(repo, pr);
  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error.message ?? error);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  await stopMayfly();
  mock.close();
  await rm(path.join(root, "data"), { recursive: true, force: true });
}
