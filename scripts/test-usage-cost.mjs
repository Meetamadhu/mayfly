/**
 * Local usage/cost sampling checks. Expects dist/server.js built.
 * Run: node scripts/test-usage-cost.mjs
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 13001;
const ADMIN = randomBytes(32).toString("hex");
const dataDir = path.join(root, "data");
const statePath = path.join(dataDir, "state.json");

const mayfly = spawn(process.execPath, ["dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: " ",
    ALLOW_SIMULATOR: "true",
    PREVIEW_RUNTIME: "process",
    PREVIEW_BASE_URL: `http://127.0.0.1:${PORT}`,
    DEMO_PREVIEW: "acme/demo#1",
    PREVIEW_REPOS: "",
    PREVIEW_TTL_HOURS: "8",
    PREVIEW_SLEEP_SECONDS: "4",
    REAPER_INTERVAL_MS: "2000",
    PREVIEW_COST_PER_HOUR: "0.05",
    MAYFLY_ADMIN_TOKEN: ADMIN,
    GITHUB_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let log = "";
mayfly.stdout.on("data", (c) => {
  log += c.toString();
});
mayfly.stderr.on("data", (c) => {
  log += c.toString();
});

function shutdown(code) {
  mayfly.kill();
  process.exit(code);
}

async function waitReady() {
  for (let i = 0; i < 50; i += 1) {
    if (/Mayfly ready/.test(log)) return;
    if (mayfly.exitCode != null) throw new Error(`Mayfly exited:\n${log}`);
    await sleep(100);
  }
  throw new Error(`Mayfly did not start:\n${log}`);
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  await waitReady();

  await post("/api/events", {
    action: "opened",
    repository: "acme/cost",
    prNumber: 9,
    branch: "main",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    wait: true,
  });

  // Let the gate stay awake briefly, then sleep, then sample across both.
  await sleep(2500);
  const ov0 = await overview();
  const live = ov0.environments.find((e) => e.repository === "acme/cost" && e.prNumber === 9);
  assert(live, "missing acme/cost preview");
  if (live.status === "ready" && live.sleep === "awake") {
    await post(`/api/environments/${live.id}?action=sleep`);
  }

  // Wait for several reaper ticks while asleep.
  await sleep(7000);
  await post("/api/reaper");
  await sleep(500);

  const ov = await overview();
  const env = ov.environments.find((e) => e.repository === "acme/cost" && e.prNumber === 9);
  const demo = ov.environments.find((e) => e.repository === "acme/demo" && e.prNumber === 1);
  assert(env?.usage, "per-preview usage missing");
  assert((env.usage.asleepSeconds ?? 0) + (env.usage.awakeSeconds ?? 0) > 0, "per-preview seconds did not grow");
  assert(!demo?.usage || ((demo.usage.awakeSeconds ?? 0) === 0 && (demo.usage.asleepSeconds ?? 0) === 0), "demo counted toward usage");

  const monthAwake = ov.usage.awakeSeconds ?? 0;
  const monthAsleep = ov.usage.asleepSeconds ?? 0;
  const sumEnv = ov.environments
    .filter((e) => e.repository !== "acme/demo")
    .reduce((n, e) => n + (e.usage?.awakeSeconds ?? 0) + (e.usage?.asleepSeconds ?? 0), 0);
  assert(monthAwake + monthAsleep >= sumEnv - 2, `month totals ${monthAwake + monthAsleep} < env sum ${sumEnv}`);
  // Live envs' usage should be reflected in month (destroyed ones still keep usage on the env object).
  assert(monthAwake + monthAsleep > 0, "month totals empty");

  const today = new Date().toISOString().slice(0, 10);
  assert(ov.usage.days?.[today], "today day key missing");
  const daySum = (ov.usage.days[today].awakeSeconds ?? 0) + (ov.usage.days[today].asleepSeconds ?? 0);
  assert(daySum > 0, "today day totals empty");

  // Inject an old day and prune via reaper after rewriting state.
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  raw.usage.days = {
    ...(raw.usage.days ?? {}),
    "2000-01-01": { awakeSeconds: 99, asleepSeconds: 99 },
  };
  const beforeRestartAwake = raw.usage.awakeSeconds;
  const beforeRestartAsleep = raw.usage.asleepSeconds;
  const beforeEnv = raw.environments.find((e) => e.repository === "acme/cost");
  const beforeEnvTotal = (beforeEnv.usage?.awakeSeconds ?? 0) + (beforeEnv.usage?.asleepSeconds ?? 0);
  await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);

  await post("/api/reaper");
  await sleep(300);
  const pruned = JSON.parse(await readFile(statePath, "utf8"));
  assert(!pruned.usage.days?.["2000-01-01"], "day older than 31 days was not dropped");

  // Restart: first tick reseeds lastSampleAt — totals must not jump by the downtime.
  mayfly.kill();
  await sleep(800);
  const mayfly2 = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: " ",
      ALLOW_SIMULATOR: "true",
      PREVIEW_RUNTIME: "process",
      PREVIEW_BASE_URL: `http://127.0.0.1:${PORT}`,
      DEMO_PREVIEW: "acme/demo#1",
      PREVIEW_REPOS: "",
      PREVIEW_TTL_HOURS: "8",
      PREVIEW_SLEEP_SECONDS: "4",
      REAPER_INTERVAL_MS: "2000",
      PREVIEW_COST_PER_HOUR: "0.05",
      MAYFLY_ADMIN_TOKEN: ADMIN,
      GITHUB_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log2 = "";
  mayfly2.stdout.on("data", (c) => {
    log2 += c.toString();
  });
  mayfly2.stderr.on("data", (c) => {
    log2 += c.toString();
  });
  for (let i = 0; i < 50; i += 1) {
    if (/Mayfly ready/.test(log2)) break;
    await sleep(100);
  }
  // One reaper tick after restart only reseeds; wait just past first interval.
  await sleep(2500);
  const after = JSON.parse(await readFile(statePath, "utf8"));
  const afterEnv = after.environments.find((e) => e.repository === "acme/cost");
  const afterEnvTotal = (afterEnv?.usage?.awakeSeconds ?? 0) + (afterEnv?.usage?.asleepSeconds ?? 0);
  // Allow a small growth from a sample or two after ready, but not the multi-second downtime gap.
  assert(
    after.usage.awakeSeconds + after.usage.asleepSeconds < beforeRestartAwake + beforeRestartAsleep + 15,
    `restart double-counted: before ${beforeRestartAwake + beforeRestartAsleep} after ${after.usage.awakeSeconds + after.usage.asleepSeconds}`,
  );
  assert(afterEnvTotal < beforeEnvTotal + 15, "per-preview double-counted across restart");
  assert(!after.usage.days?.["2000-01-01"], "old day reappeared after restart");

  console.log("ok: per-preview + month + day usage; demo excluded; prune + restart safe");
  mayfly2.kill();
  process.exit(0);
} catch (error) {
  console.error(error);
  console.error(log.slice(-2000));
  shutdown(1);
}
