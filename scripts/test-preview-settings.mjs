/**
 * Preview settings end to end, with stand-ins for docker and git (scripts/fixtures): saving a repository's
 * variables and size, values never coming back out or being saved in plain text, the size used for previews opened
 * from GitHub, and the values reaching the app's container by name only, never on a command line.
 * Run: npm run build && node scripts/test-preview-settings.mjs
 * Uses ./data (JSON state) and deletes it afterwards, and port 13022. Run it on a dev machine, not where Mayfly is
 * live. MONGODB_URI is ignored, so it never touches the real database.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(root, "data", "state.json");
const PORT = 13022;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = randomBytes(32).toString("hex");

let passed = 0;
function check(cond, message, detail) {
  if (!cond) throw new Error(`FAIL: ${message}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  passed += 1;
  console.log(`ok  ${message}`);
}

const SECRET = `s3cret-${randomBytes(6).toString("hex")}`;
const PUBLIC_URL = "https://api.example.test";

// A bin folder whose "docker" is the stand-in.
const bin = await mkdtemp(path.join(os.tmpdir(), "mayfly-fake-docker-"));
await symlink(path.join(root, "scripts", "fixtures", "fake-docker.mjs"), path.join(bin, "docker"));
await symlink(path.join(root, "scripts", "fixtures", "fake-git.mjs"), path.join(bin, "git"));
await chmod(path.join(root, "scripts", "fixtures", "fake-docker.mjs"), 0o755);
await chmod(path.join(root, "scripts", "fixtures", "fake-git.mjs"), 0o755);
const dockerLog = path.join(bin, "calls.jsonl");

let log = "";
let mayfly = null;
async function startMayfly() {
  log = "";
  mayfly = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PREVIEW_FAKE_DOCKER_LOG: dockerLog,
      PREVIEW_FAKE_DOCKER_WATCH: "API_KEY,PUBLIC_URL",
      PORT: String(PORT),
      MONGODB_URI: " ",
      PREVIEW_RUNTIME: "docker",
      DOCKER_HOST: "",
      PREVIEW_BASE_URL: BASE,
      DEMO_PREVIEW: "",
      PREVIEW_REPOS: "acme/web,acme/api",
      ALLOW_SIMULATOR: "true",
      REAPER_INTERVAL_MS: "1000",
      MAYFLY_ADMIN_TOKEN: ADMIN,
      MAYFLY_SECRETS_KEY: randomBytes(32).toString("hex"),
      GITHUB_TOKEN: "",
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
async function calls() {
  try {
    return (await readFile(dockerLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

await rm(path.join(root, "data"), { recursive: true, force: true });
await mkdir(path.join(root, "data"), { recursive: true });
try {
  await startMayfly();
  const URL_ = "/api/preview-settings/acme/web";

  const anon = await api("GET", "/api/preview-settings", undefined, { origin: BASE });
  check(anon.status === 401, "preview settings are for admins", anon.status);

  const empty = await api("GET", "/api/preview-settings");
  check(empty.status === 200 && empty.json.keyConfigured === true && empty.json.runtime === "docker", "the page sees the key is set", empty.json);

  const reserved = await api("PUT", URL_, { size: "large", vars: [{ name: "PORT", value: "1" }] });
  check(reserved.status === 400 && /set by Mayfly or Docker/.test(reserved.json.error), "names Mayfly or Docker use are refused", reserved.json);
  const proxy = await api("PUT", URL_, { vars: [{ name: "https_proxy", value: "x" }] });
  check(proxy.status === 400, "proxy settings can't be set either", proxy.json);

  const saved = await api("PUT", URL_, {
    size: "large",
    vars: [
      { name: "API_KEY", value: SECRET },
      { name: "PUBLIC_URL", value: PUBLIC_URL, build: true },
    ],
  });
  check(saved.status === 200, "a repository's settings are saved", saved.json);
  const view = saved.json.settings.find((s) => s.repository === "acme/web");
  check(view.size === "large" && view.vars.map((v) => v.name).join() === "API_KEY,PUBLIC_URL" && view.vars[1].build === true, "the page sees names, flags and size", view);
  check(!saved.text.includes(SECRET) && !saved.text.includes(PUBLIC_URL), "values are never sent back");
  const stateText = await readFile(path.join(root, "data", "state.json"), "utf8");
  check(!stateText.includes(SECRET) && /"value": "v1\./.test(stateText), "values are saved encrypted, not in plain text");

  const kept = await api("PUT", URL_, { size: "large", vars: [{ name: "API_KEY" }, { name: "PUBLIC_URL", build: true }] });
  check(kept.status === 200, "saving without retyping keeps the values", kept.json);
  const missing = await api("PUT", URL_, { vars: [{ name: "NEW_ONE" }] });
  check(missing.status === 400 && /Enter a value for NEW_ONE/.test(missing.json.error), "a new variable needs a value", missing.json);

  const opened = await api("POST", "/api/events", { action: "opened", repository: "acme/web", prNumber: 7, branch: "feat/x", sha: "a".repeat(40) });
  check(opened.status === 200, "a pull request opens a preview", opened.json);
  const env = await waitFor(async () => (await allEnvs()).find((e) => e.prNumber === 7 && e.status === "ready"), "the preview to be ready");
  check(env.size === "large", "a preview opened from GitHub gets the repository's size", env.size);

  const build = (await calls()).find((c) => c.args[0] === "build");
  check(Boolean(build), "the pull request was built", await calls());
  const argIndex = build.args.indexOf("PUBLIC_URL");
  check(argIndex > 0 && build.args[argIndex - 1] === "--build-arg" && !build.args.includes("API_KEY"), "only values marked for building go to the build, by name", build.args);
  check(build.env.PUBLIC_URL === PUBLIC_URL && !("API_KEY" in build.env) && !build.args.some((arg) => arg.includes(PUBLIC_URL)), "the build reads them from its environment", build.env);

  // The gate starts the app's container on the first visit.
  const seen = await waitFor(async () => {
    const page = await fetch(`${BASE}/p/acme/web/7/`, { headers: { accept: "application/json" } });
    return /json/.test(page.headers.get("content-type") ?? "") ? page.json() : null;
  }, "the app to answer");
  check(seen.API_KEY === SECRET && seen.PUBLIC_URL === PUBLIC_URL, "the app sees its variables", seen);

  const run = (await calls()).find((c) => c.args[0] === "run");
  check(Boolean(run), "the app container was started", await calls());
  const eIndex = run.args.indexOf("API_KEY");
  check(eIndex > 0 && run.args[eIndex - 1] === "-e" && run.args.includes("PUBLIC_URL"), "variables are passed to the container by name", run.args);
  check(!run.args.some((arg) => arg.includes(SECRET) || arg.includes(PUBLIC_URL)), "no value is on the docker command line", run.args);
  check(run.env.API_KEY === SECRET && !Object.keys(run.env).some((k) => k.startsWith("MAYFLY_APP_ENV_")), "docker reads the values from its environment", Object.keys(run.env));
  check(run.args[run.args.indexOf("--memory") + 1] === "1g", "the container gets the Large size's memory", run.args);


  const other = await api("POST", "/api/events", { action: "opened", repository: "acme/api", prNumber: 8, branch: "feat/y", sha: "b".repeat(40) });
  check(other.status === 200, "another repository's preview opens", other.json);
  await waitFor(async () => (await allEnvs()).find((e) => e.prNumber === 8 && e.status === "ready"), "the other preview");
  await waitFor(async () => {
    const page = await fetch(`${BASE}/p/acme/api/8/`);
    return /json/.test(page.headers.get("content-type") ?? "");
  }, "the other app to answer");
  const otherRun = (await calls()).filter((c) => c.args[0] === "run").at(-1);
  check(!otherRun.args.includes("API_KEY") && !("API_KEY" in otherRun.env), "other repositories don't get them", otherRun.args);

  const cleared = await api("DELETE", URL_);
  check(cleared.status === 200 && !cleared.json.settings.some((s) => s.repository === "acme/web"), "settings can be removed", cleared.json);

  for (const e of await allEnvs()) if (e.status !== "destroyed") await api("POST", `/api/environments/${e.id}?action=destroy&wait=1`);
  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error.message ?? error);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  await stopMayfly();
  await rm(path.join(root, "data"), { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}
