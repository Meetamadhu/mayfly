/**
 * Local auto-sleep policy checks (MONGODB_URI unset).
 * - Per-repo PREVIEW_SLEEP_RULES (8s) vs default (4s)
 * - Keep awake holds past idle; proxy blocks /p/.../__preview_keepawake
 * - Restart re-applies keep awake; stop resumes idle sleep
 *
 * Expects dist/server.js built. Run: node scripts/test-sleep-policy.mjs
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 13002;
const ADMIN = randomBytes(32).toString("hex");
const dataDir = path.join(root, "data");

async function resetState() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), `${JSON.stringify({ environments: [] }, null, 2)}\n`);
  await writeFile(path.join(dataDir, "deployments.json"), `${JSON.stringify({ deployments: [] }, null, 2)}\n`);
}

function baseEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: " ",
    ALLOW_SIMULATOR: "true",
    PREVIEW_RUNTIME: "process",
    PREVIEW_BASE_URL: `http://127.0.0.1:${PORT}`,
    DEMO_PREVIEW: "",
    PREVIEW_REPOS: "",
    PREVIEW_TTL_HOURS: "8",
    PREVIEW_SLEEP_SECONDS: "4",
    PREVIEW_SLEEP_RULES: "acme/rules=8,not-a-repo,bad=x,acme/rules=-1",
    MAX_CONCURRENT_ENVIRONMENTS: "10",
    REAPER_INTERVAL_MS: "60000",
    MAYFLY_ADMIN_TOKEN: ADMIN,
    GITHUB_TOKEN: "",
  };
}

function spawnMayfly() {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: baseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (c) => {
    log += c.toString();
  });
  child.stderr.on("data", (c) => {
    log += c.toString();
  });
  return {
    child,
    get log() {
      return log;
    },
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitReady(proc) {
  for (let i = 0; i < 80; i += 1) {
    if (/Mayfly ready/.test(proc.log)) return;
    if (proc.child.exitCode != null) throw new Error(`Mayfly exited:\n${proc.log}`);
    await sleep(100);
  }
  throw new Error(`Mayfly did not start:\n${proc.log}`);
}

async function post(pathName, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathName}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(`${pathName} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function overview() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/environments`, { cache: "no-store" });
  return res.json();
}

async function waitSleep(repo, pr, expect, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ov = await overview();
    const env = ov.environments.find((e) => e.repository === repo && e.prNumber === pr);
    if (env?.sleep === expect) return env;
    await sleep(400);
  }
  const ov = await overview();
  const env = ov.environments.find((e) => e.repository === repo && e.prNumber === pr);
  throw new Error(`${repo}#${pr} expected sleep=${expect}, got ${env?.sleep}`);
}

async function visit(env) {
  const pathName = new URL(env.url).pathname;
  const res = await fetch(`http://127.0.0.1:${PORT}${pathName}`, { cache: "no-store" });
  // Waking page may 200 before the app is up; a second hit settles awake.
  await sleep(800);
  await fetch(`http://127.0.0.1:${PORT}${pathName}`, { cache: "no-store" });
  assert(res.status < 500, `visit ${pathName} status ${res.status}`);
}

await resetState();
let proc = spawnMayfly();

try {
  await waitReady(proc);
  assert(/Ignoring invalid PREVIEW_SLEEP_RULES entry/.test(proc.log), "expected invalid-rule startup warning");

  await post("/api/events", {
    action: "opened",
    repository: "acme/default",
    prNumber: 1,
    branch: "main",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    wait: true,
  });
  await post("/api/events", {
    action: "opened",
    repository: "acme/rules",
    prNumber: 2,
    branch: "main",
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    wait: true,
  });

  let ov = await overview();
  const def = ov.environments.find((e) => e.repository === "acme/default" && e.prNumber === 1);
  const rules = ov.environments.find((e) => e.repository === "acme/rules" && e.prNumber === 2);
  assert(def?.status === "ready", "default preview not ready");
  assert(rules?.status === "ready", "rules preview not ready");
  assert(def.sleepSeconds === 4, `default sleepSeconds want 4 got ${def.sleepSeconds}`);
  assert(rules.sleepSeconds === 8, `rules sleepSeconds want 8 got ${rules.sleepSeconds}`);

  await visit(def);
  await visit(rules);

  // Default (4s): asleep by ~7s after last visit; rules (8s) still awake.
  await sleep(6500);
  ov = await overview();
  const defMid = ov.environments.find((e) => e.id === def.id);
  const rulesMid = ov.environments.find((e) => e.id === rules.id);
  assert(defMid.sleep === "asleep", `default should be asleep by 6.5s, got ${defMid.sleep}`);
  assert(rulesMid.sleep === "awake", `rules should still be awake at 6.5s, got ${rulesMid.sleep}`);

  await waitSleep("acme/rules", 2, "asleep", 8000);

  // Wake rules, keep awake 1h, confirm still awake past idle.
  await visit(rules);
  await post(`/api/environments/${rules.id}?action=keep_awake&hours=1`);
  ov = await overview();
  const kept = ov.environments.find((e) => e.id === rules.id);
  assert(kept.keepAwakeUntil && Date.parse(kept.keepAwakeUntil) > Date.now(), "keepAwakeUntil missing");
  assert(
    (kept.events ?? []).some((e) => e.type === "keep_awake"),
    "timeline missing keep_awake",
  );

  await sleep(10000);
  ov = await overview();
  assert(ov.environments.find((e) => e.id === rules.id)?.sleep === "awake", "keep-awake should prevent idle sleep");

  // Public proxy must 404 the private control.
  const proxyRes = await fetch(`http://127.0.0.1:${PORT}/p/acme/rules/2/__preview_keepawake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ until: null }),
  });
  assert(proxyRes.status === 404, `proxy keepawake want 404 got ${proxyRes.status}`);

  // Restart: keep-awake must still hold.
  proc.child.kill();
  await sleep(1000);
  proc = spawnMayfly();
  await waitReady(proc);
  await sleep(2500);
  ov = await overview();
  const afterRestart = ov.environments.find((e) => e.repository === "acme/rules" && e.prNumber === 2);
  assert(afterRestart?.keepAwakeUntil && Date.parse(afterRestart.keepAwakeUntil) > Date.now(), "keepAwakeUntil lost on restart");
  await sleep(10000);
  ov = await overview();
  assert(ov.environments.find((e) => e.id === afterRestart.id)?.sleep === "awake", "keep-awake not restored after restart");

  // Stop keep-awake → sleeps on schedule (8s).
  await post(`/api/environments/${afterRestart.id}?action=keep_awake_off`);
  ov = await overview();
  assert(
    (ov.environments.find((e) => e.id === afterRestart.id)?.events ?? []).some((e) => e.type === "keep_awake_off"),
    "timeline missing keep_awake_off",
  );
  // Touch so idle clock starts from now.
  await visit(afterRestart);
  await waitSleep("acme/rules", 2, "asleep", 14000);

  console.log("ok: sleep rules, keep-awake, proxy 404, restart, stop");
  proc.child.kill();
  process.exit(0);
} catch (error) {
  console.error(error);
  console.error(proc.log.slice(-3000));
  try {
    proc.child.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
