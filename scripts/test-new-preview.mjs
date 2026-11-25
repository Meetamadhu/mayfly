/**
 * "New preview" end to end: an admin starts a preview of a branch (its pull request found from the branch, or
 * given), with a size, a lifetime and a budget; a duplicate is refused; reaching the budget removes it.
 * Run: npm run build && node scripts/test-new-preview.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and ports 13020/18776. Run it on a dev machine, not where
 * Mayfly is live. MONGODB_URI is ignored, so it never touches the real database.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(root, "data", "state.json");
const MOCK_PORT = 18776;
const PORT = 13020;
const BASE = `http://127.0.0.1:${PORT}`;
const GH_TOKEN = randomBytes(12).toString("hex");
const ADMIN = randomBytes(32).toString("hex");

let passed = 0;
function check(cond, message, detail) {
  if (!cond) throw new Error(`FAIL: ${message}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  passed += 1;
  console.log(`ok  ${message}`);
}

// ---- mock GitHub: open pull requests by branch, one pull request by number, and comments ----
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
    if (req.method === "GET" && url.pathname === "/repos/acme/web/pulls") {
      const head = url.searchParams.get("head");
      if (head === "acme:feat/found") return send(200, [{ number: 42, head: { sha: "b".repeat(40), ref: "feat/found" } }]);
      return send(200, []);
    }
    if (req.method === "GET" && url.pathname === "/repos/acme/web/pulls/7") {
      return send(200, { number: 7, head: { sha: "c".repeat(40), ref: "feat/seven" } });
    }
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
      PREVIEW_TTL_HOURS: "8",
      PREVIEW_COST_PER_HOUR: "0.05",
      REAPER_INTERVAL_MS: "1000",
      MAYFLY_ADMIN_TOKEN: ADMIN,
      GITHUB_TOKEN: GH_TOKEN,
      GITHUB_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_WEBHOOK_SECRET: randomBytes(8).toString("hex"),
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
async function allEnvs() {
  return (await api("GET", "/api/environments")).json.environments;
}
async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}\n${log.slice(-2000)}`);
}
async function editEnv(repo, pr, change) {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const env = state.environments.find((e) => e.repository === repo && e.prNumber === pr && e.status !== "destroyed");
  change(env);
  await writeFile(`${stateFile}.edit`, JSON.stringify(state, null, 2));
  await rename(`${stateFile}.edit`, stateFile);
}

await rm(path.join(root, "data"), { recursive: true, force: true });
try {
  await startMayfly();

  const signedOut = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/found" }, { origin: BASE });
  check(signedOut.status === 401, "starting a preview needs an admin", signedOut.status);

  const noBranch = await api("POST", "/api/previews", { repository: "acme/web" });
  check(noBranch.status === 400 && /branch/.test(noBranch.json.error), "a missing branch is explained", noBranch.json);

  const noPr = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/none" });
  check(noPr.status === 400 && /no open pull request for feat\/none/.test(noPr.json.error), "a branch without an open pull request is explained", noPr.json);

  const wrong = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/other", prNumber: 7 });
  check(wrong.status === 400 && /is for the branch feat\/seven/.test(wrong.json.error), "a number that doesn't match the branch is refused", wrong.json);

  const started = await api("POST", "/api/previews", {
    repository: "acme/web", branch: "feat/found", title: "One-click pay", size: "large", ttlHours: 4, budget: 5,
  });
  check(started.status === 200 && started.json.environment?.prNumber === 42, "the pull request is found from the branch", started.json);
  const env = started.json.environment;
  check(env.size === "large" && env.budget === 5 && env.title === "One-click pay" && env.sha === "b".repeat(40), "size, budget, description and commit are saved", env);
  const hours = (Date.parse(env.expiresAt) - Date.now()) / 3_600_000;
  check(hours > 3.9 && hours <= 4.01, "the chosen lifetime is used", hours);

  await waitFor(async () => (await allEnvs()).find((e) => e.id === env.id)?.status === "ready", "the preview to be ready");
  check(true, "the preview builds and is ready");
  await waitFor(() => posted.some((c) => c.pr === 42 && c.body.includes("### Mayfly preview ready")), "the PR comment");
  check(true, "Mayfly comments on the pull request as usual");

  const again = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/found" });
  check(again.status === 409 && /already has a preview/.test(again.json.error), "a second preview for the same pull request is refused", again.json);

  const byNumber = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/seven", prNumber: 7, size: "small" });
  check(byNumber.status === 200 && byNumber.json.environment.prNumber === 7 && byNumber.json.environment.size === "small", "a given pull request number works", byNumber.json);
  const standard = (await allEnvs()).find((e) => e.prNumber === 7);
  check(!("budget" in standard) || standard.budget == null, "no budget unless one is chosen", standard);

  // A Large preview costs 2 × $0.05 an hour; $5 is 50 awake hours. Give it 51.
  await editEnv("acme/web", 42, (e) => {
    e.usage = { awakeSeconds: 51 * 3600, asleepSeconds: 0 };
  });
  const removed = await waitFor(
    async () => (await allEnvs()).find((e) => e.id === env.id && e.status === "destroyed"),
    "the preview to be removed at its budget",
  );
  check(removed.destroyReason === "budget", "reaching the budget removes the preview", removed.destroyReason);
  check((await allEnvs()).some((e) => e.prNumber === 7 && e.status !== "destroyed"), "the other preview is untouched");

  await api("POST", `/api/environments/${byNumber.json.environment.id}?action=destroy&wait=1`);
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
