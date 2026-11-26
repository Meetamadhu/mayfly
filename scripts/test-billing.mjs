/**
 * Prepaid credit through Razorpay end to end, against a mock Razorpay API, a mock GitHub API and signed webhooks:
 * admins only, out of credit stops new previews (with a note on the PR), creating an order (keys and paise checked),
 * Checkout's signature checked before credit is added (bad, unknown and repeated payments add nothing), the signed
 * webhook adding credit once, Razorpay refusing the keys, secrets never sent to the browser, credit kept on restart.
 * Run: npm run build && node scripts/test-billing.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and ports 13031/18787/18788. Run it on a dev machine, not
 * where Mayfly is live. MONGODB_URI is ignored, so it never touches the real database.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(root, "data", "state.json");
const MOCK_PORT = 18787;
const RZP_PORT = 18788;
const PORT = 13031;
const BASE = `http://127.0.0.1:${PORT}`;
const GH_TOKEN = randomBytes(12).toString("hex");
const ADMIN = randomBytes(32).toString("hex");
const SECRET = randomBytes(16).toString("hex");
// Test values made up for this run, not real Razorpay keys.
const RZP_KEY = "rzp_test_mayflytestkey1";
const RZP_SECRET = randomBytes(16).toString("hex");
const RZP_WEBHOOK = randomBytes(16).toString("hex");

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

// ---- mock Razorpay ----
const rzpCalls = [];
let orderSeq = 0;
const rzp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    rzpCalls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Basic ${Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64")}`) return send(401, { error: { description: "Authentication failed" } });
    if (req.method === "POST" && req.url === "/v1/orders") {
      if (body.amount === 77700) return send(401, { error: { description: "Authentication failed" } });
      orderSeq += 1;
      return send(200, { id: `order_MOCK${String(orderSeq).padStart(8, "0")}`, entity: "order", amount: body.amount, currency: body.currency, status: "created" });
    }
    send(404, { error: { description: "mock miss" } });
  });
});
await new Promise((resolve) => rzp.listen(RZP_PORT, "127.0.0.1", resolve));

const sign = (secret, message) => createHmac("sha256", secret).update(message).digest("hex");

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
      RAZORPAY_KEY_ID: RZP_KEY,
      RAZORPAY_KEY_SECRET: RZP_SECRET,
      RAZORPAY_WEBHOOK_SECRET: RZP_WEBHOOK,
      RAZORPAY_API_URL: `http://127.0.0.1:${RZP_PORT}`,
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

  // ---- admins only; nothing secret goes to the browser ----
  check((await api("GET", "/api/billing", undefined, {})).status === 401, "credit is for admins only");
  const start = await api("GET", "/api/billing");
  check(start.status === 200 && start.json.payments.enabled && start.json.payments.mode === "test" && start.json.credit === 0, "payments are set up in test mode, with no credit yet", start.json);
  const publicPlan = await api("GET", "/api/plan", undefined, {});
  check(![start.text, publicPlan.text].some((t) => t.includes(RZP_SECRET) || t.includes(RZP_WEBHOOK)), "the key secret and webhook secret are never sent to the browser");
  check(start.json.payments.keyId === RZP_KEY, "the key id (meant for Checkout) is");

  // ---- out of credit: new previews wait ----
  await webhook("opened", "acme/web", 1);
  check(!(await live("acme/web", 1)), "on Pay as you go with no credit, a new preview doesn't start");
  const note = await waitFor(() => posted.find((c) => c.pr === 1 && c.body.includes("Mayfly preview not started")), "the note on PR 1");
  check(/credit has run out/.test(note.body), "and the pull request says credit has run out", note.body);

  // ---- starting a payment ----
  check((await api("POST", "/api/billing/orders", { amount: 500 }, { origin: BASE })).status === 401, "starting a payment needs an admin");
  check((await api("POST", "/api/billing/orders", { amount: 50 })).status === 400, "₹50 is below the smallest top-up");
  const order = await api("POST", "/api/billing/orders", { amount: 500 });
  check(order.status === 200 && order.json.checkout.key === RZP_KEY && order.json.checkout.amount === 50000 && order.json.checkout.currency === "INR", "₹500 starts a payment of 50000 paise for Checkout", order.json);
  const call = rzpCalls.at(-1);
  check(call.path === "/v1/orders" && call.body.amount === 50000 && call.body.currency === "INR", "Mayfly asked Razorpay for the order with its keys, in paise", call.body);
  const orderId = order.json.checkout.orderId;

  // ---- confirming it ----
  const paymentId = "pay_MOCKPAY00001";
  const bad = await api("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign("wrong-secret", `${orderId}|${paymentId}`) });
  check(bad.status === 400 && bad.json.code === "bad_signature", "a payment with a wrong signature adds no credit", bad.json);
  const stranger = await api("POST", "/api/billing/verify", { razorpay_order_id: "order_NOTOURS0001", razorpay_payment_id: paymentId, razorpay_signature: sign(RZP_SECRET, `order_NOTOURS0001|${paymentId}`) });
  check(stranger.status === 404, "a correctly signed payment for an order Mayfly didn't start is refused", stranger.json);
  const good = await api("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(RZP_SECRET, `${orderId}|${paymentId}`) });
  check(good.status === 200 && good.json.added === 500 && good.json.credit === 500, "a properly signed payment adds ₹500", good.json);
  const again = await api("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(RZP_SECRET, `${orderId}|${paymentId}`) });
  check(again.status === 200 && again.json.added === 0 && again.json.credit === 500, "reporting the same payment again adds nothing", again.json);
  check(again.json.orders.length === 1 && again.json.orders[0].paymentId === paymentId && again.json.orders[0].mode === "test", "it's listed under payments, marked test", again.json.orders);

  // ---- with credit, previews start ----
  await webhook("opened", "acme/web", 2);
  await ready("acme/web", 2);
  check(true, "with credit, a new preview starts");

  // ---- the webhook ----
  const second = await api("POST", "/api/billing/orders", { amount: 1000 });
  const event = JSON.stringify({ event: "order.paid", payload: { order: { entity: { id: second.json.checkout.orderId, status: "paid" } }, payment: { entity: { id: "pay_MOCKPAY00002", order_id: second.json.checkout.orderId } } } });
  const hook = (body, signature) => fetch(`${BASE}/api/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature }, body });
  check((await hook(event, sign("wrong-secret", event))).status === 401, "a webhook with a wrong signature is refused");
  const hooked = await (await hook(event, sign(RZP_WEBHOOK, event))).json();
  check(hooked.ok && hooked.credited === true, "a signed order.paid webhook adds the credit (tab closed mid-payment)", hooked);
  const hookedAgain = await (await hook(event, sign(RZP_WEBHOOK, event))).json();
  check(hookedAgain.ok && hookedAgain.credited === false, "Razorpay retrying the webhook adds nothing", hookedAgain);
  const ignored = JSON.stringify({ event: "payment.failed", payload: {} });
  check((await (await hook(ignored, sign(RZP_WEBHOOK, ignored))).json()).ignored === true, "other events are ignored");
  const nearly = (credit) => credit > 1499 && credit <= 1500; // a few awake seconds may already have come off
  check(nearly((await api("GET", "/api/billing")).json.credit), "credit is now ₹1,500 (less any awake seconds since)");

  // ---- Razorpay refusing ----
  const refused = await api("POST", "/api/billing/orders", { amount: 777 });
  check(refused.status === 502 && /didn't accept the keys/.test(refused.json.error), "if Razorpay refuses the keys, the admin is told plainly", refused.json);

  // ---- kept on restart ----
  await stopMayfly();
  await startMayfly();
  const after = await api("GET", "/api/billing");
  check(nearly(after.json.credit) && after.json.orders.length === 2, "credit and payments are still there after a restart", after.json);

  await close("acme/web", 2);
  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error.message ?? error);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  await stopMayfly();
  mock.close();
  rzp.close();
  await rm(path.join(root, "data"), { recursive: true, force: true });
}
