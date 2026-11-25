/**
 * Feedback on previews end to end: the feedback link, who may read and post comments, the note on the pull request,
 * what the public API hides, the helper Mayfly adds to framed preview pages (and only to those), and deleting.
 * Run: npm run build && node scripts/test-feedback.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and ports 13021/18777. Run it on a dev machine, not where
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
const MOCK_PORT = 18777;
const PORT = 13021;
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

  const started = await api("POST", "/api/previews", { repository: "acme/web", branch: "feat/found", title: "One-click pay" });
  check(started.status === 200, "a preview starts", started.json);
  const env = started.json.environment;
  await waitFor(async () => (await allEnvs()).find((e) => e.id === env.id)?.status === "ready", "the preview to be ready");
  const ready = await waitFor(() => posted.find((c) => c.pr === 42 && c.body.includes("### Mayfly preview ready")), "the ready comment");
  check(/\| \*\*Feedback\*\* \| \[Mark a spot on the preview and comment\]\(http[^)]*\/review\/acme\/web\/42\?key=[0-9a-f]{32}\) \|/.test(ready.body), "the PR comment has the feedback link", ready.body);

  const FB = "/api/feedback/acme/web/42";
  const anon = await api("GET", FB, undefined, { origin: BASE });
  check(anon.status === 401, "comments need the link or an admin", anon.status);

  const asAdmin = await api("GET", FB);
  check(asAdmin.status === 200 && asAdmin.json.admin === true && asAdmin.json.postsToGithub === true, "an admin can read them", asAdmin.json);
  const key = /key=([0-9a-f]{32})/.exec(asAdmin.json.link ?? "")?.[1];
  check(Boolean(key) && asAdmin.json.preview.path === "/p/acme/web/42/", "an admin gets the feedback link and the frame path", asAdmin.json);

  const withKey = { "x-mayfly-feedback-key": key, origin: BASE };
  const viaLink = await api("GET", FB, undefined, withKey);
  check(viaLink.status === 200 && viaLink.json.admin === false && !("link" in viaLink.json), "the link opens the comments, without the admin extras", viaLink.json);

  const wrongKey = await api("GET", FB, undefined, { "x-mayfly-feedback-key": "0".repeat(32), origin: BASE });
  check(wrongKey.status === 401, "a wrong key is refused", wrongKey.status);
  const otherPr = await api("GET", "/api/feedback/acme/web/99", undefined, withKey);
  check(otherPr.status === 404, "no preview, no comments", otherPr.status);

  const spot = { path: "/checkout?step=2", x: 120, y: 840, w: 300, h: 60, viewportWidth: 390 };
  const noName = await api("POST", FB, { ...spot, author: " ", body: "Too close" }, withKey);
  check(noName.status === 400 && /name/.test(noName.json.error), "a comment needs a name", noName.json);
  const noText = await api("POST", FB, { ...spot, author: "Priya", body: "   " }, withKey);
  check(noText.status === 400 && /needs changing/.test(noText.json.error), "a comment needs text", noText.json);

  const added = await api("POST", FB, { ...spot, author: "Priya", body: "Button too close to the edge\ncc @octocat <b>now</b>" }, withKey);
  check(added.status === 200 && added.json.item.author === "Priya" && added.json.item.y === 840, "a comment is saved with its spot", added.json);
  const item = added.json.item;
  check(item.sha === env.sha && item.path === "/checkout?step=2" && item.viewportWidth === 390, "it keeps the commit, page and screen width", item);

  const note = await waitFor(() => posted.find((c) => c.pr === 42 && c.body.startsWith("**Feedback from Priya**")), "the feedback note");
  check(note.body.includes("> Button too close to the edge") && note.body.includes("`/checkout?step=2`"), "the comment is posted on the pull request", note.body);
  check(!note.body.includes("@octocat") && !note.body.includes("<b>"), "the note can't @mention anyone or add HTML", note.body);
  check(note.body.includes(`#c-${item.id})`), "the note links to the comment on the preview", note.body);

  const pub = await api("GET", "/api/environments", undefined, {});
  const pubEnv = pub.json.environments.find((e) => e.id === env.id);
  const pubEvent = (pubEnv.events ?? []).find((e) => e.type === "feedback");
  check(!("feedback" in pubEnv) && pubEvent && !("detail" in pubEvent), "visitors don't see comments or who wrote them", pubEnv);
  const adminEnv = (await allEnvs()).find((e) => e.id === env.id);
  check(adminEnv.feedback?.length === 1 && adminEnv.events.some((e) => e.type === "feedback" && e.detail === "Priya"), "admins do", adminEnv.feedback);

  // The helper goes into pages loaded in a frame, and only those.
  const framed = await fetch(`${BASE}/p/acme/web/42/`, { headers: { "sec-fetch-dest": "iframe", "accept-encoding": "gzip" } });
  const framedHtml = await framed.text();
  check(framed.status === 200 && framedHtml.includes('<script src="/feedback-frame.js" async></script>'), "a framed preview page gets the feedback helper", framedHtml.slice(0, 300));
  check(/sec-fetch-dest/i.test(framed.headers.get("vary") ?? ""), "framed and normal copies are cached apart", framed.headers.get("vary"));
  check(Number(framed.headers.get("content-length")) === Buffer.byteLength(framedHtml), "the length is right after adding it", framed.headers.get("content-length"));
  const normal = await fetch(`${BASE}/p/acme/web/42/`, { headers: { "sec-fetch-dest": "document" } });
  const normalHtml = await normal.text();
  check(normal.status === 200 && !normalHtml.includes("feedback-frame.js"), "a preview opened normally is left as the app sent it");
  const helper = await fetch(`${BASE}/feedback-frame.js`);
  check(helper.status === 200 && /javascript/.test(helper.headers.get("content-type") ?? ""), "the helper script is served", helper.status);
  const reviewPage = await fetch(`${BASE}/review/acme/web/42?key=${key}`);
  check(reviewPage.status === 200 && (await reviewPage.text()).includes("Review · Mayfly"), "the review page loads", reviewPage.status);

  const delAsLink = await api("DELETE", `${FB}/${item.id}`, undefined, withKey);
  check(delAsLink.status === 401, "only admins delete comments", delAsLink.status);
  const del = await api("DELETE", `${FB}/${item.id}`);
  check(del.status === 200 && (await api("GET", FB)).json.items.length === 0, "an admin deletes a comment", del.json);

  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const r = await api("POST", FB, { ...spot, author: "Bot", body: `Spam ${i}` }, withKey);
    if (r.status === 429) limited = i;
  }
  check(limited === 19, "a flood of comments is slowed down (20 per 10 minutes)", limited);

  await api("POST", `/api/environments/${env.id}?action=destroy&wait=1`);
  const gone = await api("GET", FB, undefined, withKey);
  check(gone.status === 404, "a removed preview takes no comments", gone.status);
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
