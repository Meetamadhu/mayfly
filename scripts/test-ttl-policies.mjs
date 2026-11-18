/**
 * TTL policies end to end, against a mock GitHub API and signed webhooks.
 * Run: npm run build && node scripts/test-ttl-policies.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and ports 13010/18766. Run it on a dev machine,
 * not where Mayfly is live. MONGODB_URI is ignored, so it never touches the real database.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(root, "data", "state.json");
const MOCK_PORT = 18766;
const PORT = 13010;
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

// ---- mock GitHub: records posted comments for any repository ----
const posted = [];
const patched = [];
let nextId = 500;
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
    if (req.method === "GET" && /\/issues\/\d+\/comments$/.test(url.pathname)) return send(200, []);
    const issue = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (req.method === "POST" && issue) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const row = { id: nextId++, repo: issue[1], pr: Number(issue[2]), body: String(body.body ?? "") };
      posted.push(row);
      return send(201, row);
    }
    if (req.method === "PATCH") {
      patched.push(String(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").body ?? ""));
      return send(200, {});
    }
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
      PREVIEW_TTL_HOURS: "8",
      PREVIEW_SLEEP_SECONDS: "20",
      PREVIEW_SLEEP_RULES: "acme/rules=60",
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

const admin = { authorization: `Bearer ${ADMIN}` };
async function api(method, url, body, headers = admin) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function webhook(action, repo, pr, labels, sha, author) {
  const payload = JSON.stringify({
    action,
    repository: { full_name: repo },
    pull_request: {
      number: pr,
      merged: false,
      labels: labels.map((name) => ({ name })),
      ...(author ? { user: { login: author } } : {}),
      head: { sha: sha ?? "a".repeat(40), ref: `feature/${pr}`, repo: { full_name: repo } },
    },
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
  return { status: res.status, json: await res.json() };
}

async function envFor(repo, pr) {
  const { json } = await api("GET", "/api/environments");
  return json.environments.find((e) => e.repository === repo && e.prNumber === pr && e.status !== "destroyed");
}
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}\n${log.slice(-2000)}`);
}
async function gateSleep(repo, pr) {
  const res = await fetch(`${BASE}/p/${repo}/${pr}/__preview_status`);
  return (await res.json()).sleepSeconds;
}
/** Edit saved state while Mayfly runs (JSON mode reads the file on every access). */
async function editEnv(repo, pr, change) {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const env = state.environments.find((e) => e.repository === repo && e.prNumber === pr && e.status !== "destroyed");
  change(env);
  await writeFile(`${stateFile}.edit`, JSON.stringify(state, null, 2));
  await rename(`${stateFile}.edit`, stateFile);
}
const hoursLeft = (env) => (Date.parse(env.expiresAt) - Date.now()) / 3_600_000;

await rm(path.join(root, "data"), { recursive: true, force: true });
try {
  await startMayfly();

  // --- access ---
  check((await api("GET", "/api/admin/policy", undefined, {})).status === 401, "policy API needs admin");
  const page = await api("GET", "/policies", undefined, {});
  check(
    page.status === 307 && /\/admin\/login\?next=\/policies/.test(page.headers.get("location") ?? ""),
    "policies page sends signed-out visitors to sign-in",
    [page.status, page.headers.get("location")],
  );
  const first = await api("GET", "/api/admin/policy");
  check(
    first.json.policy.ttlHours === null &&
      first.json.defaults.ttlHours === 8 &&
      first.json.defaults.sleepSeconds === 20 &&
      first.json.defaults.sleepRules["acme/rules"] === 60 &&
      first.json.policy.keepLabel === "keep-preview",
    "starts on server defaults",
    first.json,
  );

  // --- validation ---
  const bad = [
    [{ ttlHours: 0 }, "lifetime 0"],
    [{ ttlHours: 721 }, "lifetime 721"],
    [{ ttlHours: 1.5 }, "lifetime 1.5"],
    [{ sleepSeconds: 4 }, "sleep 4 s"],
    [{ maxExtensions: 21 }, "21 extensions"],
    [{ maxPerAuthor: 0 }, "0 previews per developer"],
    [{ warnMinutes: 7 }, "warning 7 min"],
    [{ keepLabel: "x".repeat(51) }, "51-char label"],
    [{ repoRules: [{ repository: "nope", ttlHours: 2 }] }, "rule without owner/name"],
    [{ repoRules: [{ repository: "a/b" }] }, "rule with nothing set"],
    [{ repoRules: [{ repository: "a/b", ttlHours: 2 }, { repository: "A/B", sleepSeconds: 9 }] }, "duplicate rule"],
  ];
  for (const [body, name] of bad) {
    const res = await api("PUT", "/api/admin/policy", body);
    check(res.status === 400 && typeof res.json.error === "string", `rejects ${name}`, res.json);
  }

  // Cookie session from another site can't save (same-origin check).
  const signIn = await fetch(`${BASE}/api/admin/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ token: ADMIN }),
  });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  const cross = await api("PUT", "/api/admin/policy", { ttlHours: 1 }, { cookie, origin: "https://evil.example" });
  check(cross.status === 403, "cross-site save is refused", cross.status);
  const same = await api("GET", "/api/admin/policy", undefined, { cookie });
  check(same.status === 200, "signed-in cookie can read");

  // --- save ---
  const policy = {
    ttlHours: 24,
    sleepSeconds: 30,
    maxExtensions: 1,
    keepLabel: "keep-preview",
    warnMinutes: 60,
    repoRules: [{ repository: "Acme/Short", ttlHours: 2, sleepSeconds: 10 }],
  };
  const saved = await api("PUT", "/api/admin/policy", policy, { cookie, origin: BASE });
  check(
    saved.status === 200 &&
      saved.json.policy.ttlHours === 24 &&
      saved.json.policy.repoRules[0].repository === "acme/short" &&
      Number.isFinite(Date.parse(saved.json.policy.updatedAt)),
    "saves a valid policy (repo name lower-cased)",
    saved.json,
  );

  // --- new previews pick up lifetime and sleep ---
  for (const [repo, pr] of [
    ["acme/short", 1],
    ["acme/web", 2],
    ["acme/rules", 3],
  ]) {
    const res = await webhook("opened", repo, pr, []);
    check(res.status === 200, `webhook opens ${repo}#${pr}`, res.json);
  }
  const short = await waitFor(async () => {
    const e = await envFor("acme/short", 1);
    return e?.status === "ready" ? e : null;
  }, "acme/short ready");
  const web = await waitFor(async () => {
    const e = await envFor("acme/web", 2);
    return e?.status === "ready" ? e : null;
  }, "acme/web ready");
  await waitFor(async () => (await envFor("acme/rules", 3))?.status === "ready", "acme/rules ready");
  check(Math.abs(hoursLeft(short) - 2) < 0.05, "repo rule lifetime: acme/short gets 2 h", hoursLeft(short));
  check(Math.abs(hoursLeft(web) - 24) < 0.05, "default lifetime: acme/web gets 24 h", hoursLeft(web));
  check((await gateSleep("acme/short", 1)) === 10, "repo rule sleep: acme/short sleeps after 10 s");
  check((await gateSleep("acme/web", 2)) === 30, "page default sleep: acme/web sleeps after 30 s");
  check((await gateSleep("acme/rules", 3)) === 60, "PREVIEW_SLEEP_RULES beats the page default");
  const readyBody = await waitFor(
    () => posted.find((c) => c.repo === "acme/web" && c.pr === 2 && c.body.includes("<!-- mayfly-preview -->"))?.body,
    "ready comment on acme/web",
  );
  check(
    /Expires \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC\./.test(readyBody) &&
      readyBody.includes("add the `keep-preview` label") &&
      readyBody.includes("Sleeps after 30 s without visits") &&
      !/\d{4}-\d{2}-\d{2}T/.test(readyBody),
    "PR comment shows a readable expiry, the keep label and the sleep time",
    readyBody,
  );

  // --- sleep change reaches running previews ---
  const resave = await api("PUT", "/api/admin/policy", { ...policy, sleepSeconds: 45 });
  check(resave.json.gates?.updated >= 1 && resave.json.gates.failed === 0, "save pushes the new sleep time", resave.json.gates);
  check((await gateSleep("acme/web", 2)) === 45, "acme/web now sleeps after 45 s");
  check((await gateSleep("acme/short", 1)) === 10, "acme/short keeps its rule (10 s)");
  check((await gateSleep("acme/rules", 3)) === 60, "acme/rules keeps PREVIEW_SLEEP_RULES (60 s)");

  // --- the gate's idle control is private ---
  for (const p of ["__preview_idle", "%5F%5Fpreview_idle", "./__preview_idle"]) {
    await fetch(`${BASE}/p/acme/web/2/${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds: 1 }),
    });
  }
  check((await gateSleep("acme/web", 2)) === 45, "public /p/ paths can't change the sleep time");

  // --- extension limit ---
  const ext1 = await api("POST", `/api/environments/${web.id}?action=extend&hours=2`);
  check(ext1.status === 200 && ext1.json.environment.extensions === 1, "first extend works", ext1.json);
  const extendedDay = new Date(ext1.json.environment.expiresAt).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
  check(patched.some((b) => b.includes(`Expires ${extendedDay} UTC`)), "extending edits the PR comment's expiry", extendedDay);
  const ext2 = await api("POST", `/api/environments/${web.id}?action=extend&hours=2`);
  check(ext2.status === 400 && /used all 1 extension/.test(ext2.json.error), "second extend is refused", ext2.json);

  // --- keep label ---
  const labeled = await webhook("labeled", "acme/short", 1, ["bug", "Keep-Preview"]);
  check(labeled.status === 200 && labeled.json.action === "labels", "label event is applied (any case)", labeled.json);
  check((await envFor("acme/short", 1)).keptByLabel === true, "overview shows kept by label");
  check(
    patched.some((b) => b.includes("Kept open by the `keep-preview` label")),
    "adding the label edits the PR comment",
  );
  await editEnv("acme/short", 1, (e) => {
    e.expiresAt = new Date(Date.now() - 60_000).toISOString();
  });
  await sleep(3500);
  const held = await envFor("acme/short", 1);
  check(held?.status === "ready", "an expired preview with the label is not removed");
  const unlabeled = await webhook("unlabeled", "acme/short", 1, ["bug"]);
  check(unlabeled.json.action === "labels", "label removal is applied", unlabeled.json);
  const released = await envFor("acme/short", 1);
  check(
    released.keptByLabel === false && Math.abs(hoursLeft(released) - 2) < 0.05,
    "removing the label restarts the 2 h lifetime",
    hoursLeft(released),
  );
  const kinds = released.events.map((e) => e.type);
  check(kinds.includes("kept") && kinds.includes("unkept"), "timeline records kept and unkept", kinds);
  const noPreview = await webhook("labeled", "acme/none", 9, ["keep-preview"]);
  check(noPreview.status === 404, "label on a PR without a preview is a no-op 404", noPreview.status);
  const sync = await webhook("synchronize", "acme/short", 1, ["keep-preview"], "b".repeat(40));
  check(sync.status === 200, "a new commit with the label is accepted");
  await waitFor(async () => (await envFor("acme/short", 1))?.keptByLabel === true, "label from synchronize");

  // --- expiry warning ---
  const before = posted.length;
  await editEnv("acme/web", 2, (e) => {
    e.createdAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    e.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  });
  const warning = await waitFor(
    () => posted.slice(before).find((c) => c.repo === "acme/web" && c.pr === 2 && /expires in about/.test(c.body)),
    "expiry warning comment",
  );
  check(!warning.body.includes("<!-- mayfly-preview -->"), "warning is a separate comment (no edit-in-place marker)");
  check(
    /30 minutes/.test(warning.body) && /`keep-preview` label/.test(warning.body) && warning.body.includes(`${BASE}/admin`),
    "warning says when, and how to keep the preview",
    warning.body,
  );
  await sleep(3500);
  const warnings = posted.filter((c) => c.repo === "acme/web" && /expires in about/.test(c.body));
  check(warnings.length === 1, "warning is posted once per expiry", warnings.length);
  check((await envFor("acme/web", 2)).events.some((e) => e.type === "warned"), "timeline records the warning");
  const shortWarned = posted.some((c) => c.repo === "acme/short" && /expires in about/.test(c.body));
  check(!shortWarned, "a kept preview gets no warning");

  // --- previews per developer ---
  await api("PUT", "/api/admin/policy", { ...policy, sleepSeconds: 45, maxPerAuthor: 1 });
  const firstOwn = await webhook("opened", "acme/web", 20, [], "c".repeat(40), "dev-a");
  check(firstOwn.status === 200, "a developer's first preview starts", firstOwn.json);
  await waitFor(async () => (await envFor("acme/web", 20))?.status === "ready", "acme/web#20 ready");
  check((await envFor("acme/web", 20)).author === "dev-a", "the preview records its author");
  const secondOwn = await webhook("opened", "acme/web", 21, [], "d".repeat(40), "Dev-A");
  check(
    secondOwn.status === 409 && secondOwn.json.code === "author_cap" && !(await envFor("acme/web", 21)),
    "over the limit (any letter case) no preview starts",
    secondOwn.json,
  );
  const explained = await waitFor(
    () => posted.find((c) => c.repo === "acme/web" && c.pr === 21 && /not started/.test(c.body))?.body,
    "explanation comment on #21",
  );
  check(/#20 in this repository/.test(explained) && /\(1\)/.test(explained), "the PR comment says why and which PR", explained);
  const otherDev = await webhook("opened", "acme/web", 22, [], "e".repeat(40), "dev-b");
  check(otherDev.status === 200, "another developer is not affected", otherDev.json);
  const noAuthor = await webhook("opened", "acme/web", 23, [], "f".repeat(40));
  check(noAuthor.status === 200, "events without an author (simulator) are not limited", noAuthor.json);
  await webhook("closed", "acme/web", 20, [], "c".repeat(40), "dev-a");
  await waitFor(async () => !(await envFor("acme/web", 20)), "acme/web#20 closed");
  const retry = await webhook("synchronize", "acme/web", 21, [], "d".repeat(40), "dev-a");
  check(retry.status === 200 && retry.json.action === "created", "after closing one, a new push starts it", retry.json);
  await waitFor(async () => (await envFor("acme/web", 21))?.status === "ready", "acme/web#21 ready");
  for (const pr of [21, 22, 23]) await webhook("closed", "acme/web", pr, []);
  await api("PUT", "/api/admin/policy", { ...policy, sleepSeconds: 45 });

  // --- renaming the label releases previews it held ---
  await api("PUT", "/api/admin/policy", { ...policy, sleepSeconds: 45, keepLabel: "pin" });
  const renamed = await envFor("acme/short", 1);
  check(renamed.keptByLabel === false && hoursLeft(renamed) > 1.9, "renamed label releases with a fresh lifetime", hoursLeft(renamed));

  // --- survives a restart, and restored gates use saved sleep times ---
  await stopMayfly();
  await startMayfly();
  const after = await api("GET", "/api/admin/policy");
  check(after.json.policy.sleepSeconds === 45 && after.json.policy.keepLabel === "pin", "policy survives a restart", after.json.policy);
  await waitFor(async () => (await gateSleep("acme/web", 2).catch(() => null)) === 45, "restored gate sleep time");
  check(true, "restored acme/web gate sleeps after 45 s");

  // Close the test previews so their gates stop.
  for (const [repo, pr] of [
    ["acme/short", 1],
    ["acme/web", 2],
    ["acme/rules", 3],
  ]) {
    await webhook("closed", repo, pr, []);
  }
  await waitFor(async () => !(await envFor("acme/web", 2)), "test previews closed");

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
