/**
 * Local mock of GitHub's comment API + Mayfly lifecycle exercise.
 * Run: node scripts/test-pr-comment-upsert.mjs
 * Expects dist/server.js already built.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MOCK_PORT = 18765;
const MAYFLY_PORT = 13000;
const TOKEN = "test-mayfly-token";
const ADMIN = "0972199b358ac9bc7fe9d24e879096190694f3f51c87c7b8ca07dda1768c36cd";
const REPO = "acme/comments";
const PR = 42;

/** @type {Map<number, { id: number, body: string, user: { login: string }, created_at: string, edits: number }>} */
const comments = new Map();
let nextId = 100;
let posts = 0;
let patches = 0;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const mock = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${MOCK_PORT}`);
  const path = url.pathname;
  const auth = req.headers.authorization || "";
  if (!auth.includes(TOKEN) && path !== "/") {
    return json(res, 401, { message: "Bad credentials" });
  }

  if (req.method === "GET" && path === "/user") {
    return json(res, 200, { login: "mayfly-bot" });
  }

  if (req.method === "GET" && path === `/repos/${REPO}/issues/${PR}/comments`) {
    const page = Number(url.searchParams.get("page") || "1");
    const perPage = Number(url.searchParams.get("per_page") || "100");
    const all = [...comments.values()].sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    return json(res, 200, all.slice(start, start + perPage));
  }

  if (req.method === "POST" && path === `/repos/${REPO}/issues/${PR}/comments`) {
    const body = await readBody(req);
    posts += 1;
    const id = nextId++;
    const row = {
      id,
      body: String(body.body ?? ""),
      user: { login: "mayfly-bot" },
      created_at: new Date().toISOString(),
      edits: 1,
    };
    comments.set(id, row);
    return json(res, 201, row);
  }

  const patchMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
  if (req.method === "PATCH" && patchMatch) {
    const id = Number(patchMatch[1]);
    const existing = comments.get(id);
    if (!existing) return json(res, 404, { message: "Not Found" });
    const body = await readBody(req);
    patches += 1;
    existing.body = String(body.body ?? "");
    existing.edits += 1;
    return json(res, 200, existing);
  }

  // Commit statuses — accept and ignore.
  if (req.method === "POST" && /\/repos\/.+\/statuses\//.test(path)) {
    await readBody(req).catch(() => ({}));
    return json(res, 201, { id: 1, state: "success" });
  }

  json(res, 404, { message: `mock miss ${req.method} ${path}` });
});

await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

const mayfly = spawn(process.execPath, ["dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(MAYFLY_PORT),
    MONGODB_URI: " ",
    ALLOW_SIMULATOR: "true",
    PREVIEW_RUNTIME: "process",
    PREVIEW_BASE_URL: `http://127.0.0.1:${MAYFLY_PORT}`,
    DEMO_PREVIEW: "",
    PREVIEW_REPOS: "",
    PREVIEW_TTL_HOURS: "8",
    MAYFLY_ADMIN_TOKEN: ADMIN,
    GITHUB_TOKEN: TOKEN,
    GITHUB_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let mayflyLog = "";
mayfly.stdout.on("data", (c) => {
  mayflyLog += c.toString();
});
mayfly.stderr.on("data", (c) => {
  mayflyLog += c.toString();
});

function shutdown(code) {
  mayfly.kill();
  mock.close();
  process.exit(code);
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    if (/Mayfly ready/.test(mayflyLog)) return;
    if (mayfly.exitCode != null) throw new Error(`Mayfly exited early:\n${mayflyLog}`);
    await sleep(100);
  }
  throw new Error(`Mayfly did not start:\n${mayflyLog}`);
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${MAYFLY_PORT}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const jsonBody = await res.json();
  if (!res.ok || jsonBody.ok === false) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(jsonBody)}`);
  }
  return jsonBody;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  await waitReady();

  // Seed a foreign comment that has the marker — must never be edited.
  const foreignId = nextId++;
  comments.set(foreignId, {
    id: foreignId,
    body: "<!-- mayfly-preview -->\n**fake**\n",
    user: { login: "attacker" },
    created_at: new Date().toISOString(),
    edits: 1,
  });

  await post("/api/events", {
    action: "opened",
    repository: REPO,
    prNumber: PR,
    branch: "main",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    wait: true,
  });
  await post("/api/events", {
    action: "synchronize",
    repository: REPO,
    prNumber: PR,
    branch: "main",
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    wait: true,
  });
  await post("/api/events", {
    action: "synchronize",
    repository: REPO,
    prNumber: PR,
    branch: "main",
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    wait: true,
  });
  await post("/api/events", {
    action: "closed",
    repository: REPO,
    prNumber: PR,
    branch: "",
    sha: "",
    wait: true,
  });

  const ours = [...comments.values()].filter((c) => c.user.login === "mayfly-bot");
  assert(ours.length === 1, `expected 1 mayfly comment, got ${ours.length}`);
  assert(posts === 1, `expected 1 POST, got ${posts}`);
  assert(patches === 3, `expected 3 PATCHes (edited 4 times total with create), got ${patches}`);
  assert(ours[0].edits === 4, `expected edits=4 on the comment, got ${ours[0].edits}`);
  assert(ours[0].body.includes("<!-- mayfly-preview -->"), "missing marker");
  assert(/removed/i.test(ours[0].body), "destroy body should say removed");
  assert(comments.get(foreignId).edits === 1, "foreign marker comment was touched");
  assert(comments.get(foreignId).body.includes("**fake**"), "foreign body changed");

  // Deleted comment → next publish posts a replacement.
  const only = ours[0];
  comments.delete(only.id);
  const beforePosts = posts;
  await post("/api/events", {
    action: "opened",
    repository: REPO,
    prNumber: PR,
    branch: "main",
    sha: "dddddddddddddddddddddddddddddddddddddddd",
    wait: true,
  });
  assert(posts === beforePosts + 1, "deleted comment should be replaced with a POST");
  const after = [...comments.values()].filter((c) => c.user.login === "mayfly-bot");
  assert(after.length === 1, `expected 1 replacement comment, got ${after.length}`);
  assert(after[0].id !== only.id, "replacement should be a new id");
  assert(comments.get(foreignId).edits === 1, "foreign comment touched on replace");

  console.log("ok: one comment edited in place; foreign ignored; deleted replaced");
  shutdown(0);
} catch (error) {
  console.error(error);
  console.error(mayflyLog.slice(-2000));
  shutdown(1);
}
