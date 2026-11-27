/**
 * The cost and control features inside the real lifecycle, against a throwaway data folder and a stand-in for a
 * preview's gate: usage split by repository, the budget (alert state, pausing, blocking new previews, resuming),
 * awake hours and pre-wakes (what the gate is told), and the smoke test and comparison run on a preview.
 * Run with: npx tsx scripts/test-cost-control.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const here = process.cwd();
const dir = mkdtempSync(path.join(os.tmpdir(), "mayfly-cost-control-"));
mkdirSync(path.join(dir, "data"));
process.chdir(dir);
Object.assign(process.env, {
  MONGODB_URI: "",
  GITHUB_TOKEN: "",
  GITHUB_APP_ID: "",
  DEMO_PREVIEW: "",
  PREVIEW_REPOS: "",
  PREVIEW_RUNTIME: "process",
  PREVIEW_COST_PER_HOUR: "10",
  PREVIEW_BASE_URL: "http://127.0.0.1:3199",
  MAYFLY_ADMIN_TOKEN: "temp-test-token-cost-control",
});
delete process.env.DEPLOYER;
delete process.env.VERCEL;

const SHA = "a".repeat(40);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // A stand-in for a preview's gate.
  const gate = { state: "awake" as "awake" | "asleep", keepAwake: [] as (string | null)[], sleeps: 0 };
  const server = createServer((req, res) => {
    const reply = (status: number, body: string, type = "application/json") => res.writeHead(status, { "content-type": type }).end(body);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/__preview_status") return reply(200, JSON.stringify({ state: gate.state, sleepSeconds: 300, lastWakeMs: null, sleptAt: null, wokeAt: null }));
      if (req.url === "/__preview_keepawake") {
        const until = (JSON.parse(body || "{}") as { until?: string | null }).until ?? null;
        gate.keepAwake.push(until);
        if (until) gate.state = "awake";
        return reply(200, "{}");
      }
      if (req.url === "/__preview_sleep") {
        gate.sleeps += 1;
        gate.state = "asleep";
        return reply(200, "{}");
      }
      if (req.url === "/__preview_idle") return reply(200, "{}");
      reply(200, `<!doctype html><body style="margin:0;background:${req.url === "/prod" ? "#f7f5ef" : "#c0392b"}"><h1>Hello from the preview</h1></body>`, "text/html");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const store = await import("../src/lib/store");
  const lifecycle = await import("../src/lib/lifecycle");
  const budget = await import("../src/lib/budget");
  const { findBrowser, visualDir } = await import("../src/lib/visual-diff");
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const env = {
    id: "env-1",
    repository: "acme/web",
    prNumber: 1,
    sha: SHA,
    branch: "feature",
    status: "ready",
    deploymentId: "dep_1",
    url: "http://127.0.0.1:3199/p/acme/web/1",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    lastActiveAt: now,
    destroyedAt: null,
    destroyReason: null,
    error: null,
    updateGeneration: 1,
    comments: [],
    events: [{ at: now, type: "opened" }],
    labels: [],
    extensions: 0,
  };
  await store.saveState({ environments: [env as never] });
  writeFileSync(
    path.join(dir, "data", "deployments.json"),
    JSON.stringify({ deployments: [{ deploymentId: "dep_1", repository: "acme/web", prNumber: 1, sha: SHA, branch: "feature", url: env.url, createdAt: now, updatedAt: now, port }] }),
  );
  const get = async () => (await lifecycle.getEnvironment("env-1"))!;
  const patchState = async (change: (state: Awaited<ReturnType<typeof store.loadState>>) => void) =>
    store.exclusive(async () => {
      const state = await store.loadState();
      change(state);
      await store.saveState(state);
    });

  // ── Usage by repository ─────────────────────────────────────────────────────────────────────
  await lifecycle.reap(); // the first tick only starts the clock
  await sleep(1300);
  await lifecycle.reap();
  let state = await store.loadState();
  const day = state.usage?.days?.[today];
  assert.ok((day?.repos?.["acme/web"]?.awakeSeconds ?? 0) >= 1, "awake time is recorded against the repository");
  assert.equal(day?.repos?.["acme/web"]?.awakeSeconds, day?.awakeSeconds, "and matches the day's total");
  // It survives being saved and loaded again.
  assert.deepEqual((await store.loadState()).usage?.days?.[today]?.repos, day?.repos);

  // ── Budget: warn, pause, block, resume ─────────────────────────────────────────────────────
  assert.equal(budget.previewsPaused(), false);
  await patchState((s) => {
    s.budget = { monthlyLimit: 0.002, pauseAtLimit: true, notified: null, resumedMonth: null, updatedAt: null };
  });
  await lifecycle.reap();
  assert.equal(budget.previewsPaused(), true, "spend is over the tiny limit, so previews are paused");
  assert.equal(budget.currentBudgetStatus()?.level, "over");
  state = await store.loadState();
  assert.equal(state.budget?.notified?.reached, true, "the alert is remembered, so it goes out once");
  assert.ok(gate.sleeps >= 1, "an awake preview is put to sleep while paused");
  assert.equal(gate.state, "asleep");

  const blocked = await lifecycle.applyPullRequestEvent({ action: "opened", repository: "acme/other", prNumber: 2, sha: SHA, branch: "x" }, { wait: true });
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.code === "plan_cap" && blocked.error === budget.PAUSED_MESSAGE, "new previews wait while paused");
  const blockedUpdate = await lifecycle.applyPullRequestEvent({ action: "synchronize", repository: "acme/web", prNumber: 1, sha: "b".repeat(40), branch: "feature" }, { wait: true });
  assert.ok(!blockedUpdate.ok && blockedUpdate.code === "plan_cap", "so do updates (a rebuild would wake the preview)");
  assert.equal((await get()).sha, SHA);
  assert.equal((await lifecycle.applyScheduling()).told, 0, "nothing is woken by a schedule while paused");

  // Resume for the month.
  await patchState((s) => {
    s.budget = { ...s.budget!, resumedMonth: today.slice(0, 7) };
  });
  await lifecycle.reap();
  assert.equal(budget.previewsPaused(), false, "resumed");
  // Raising the limit also clears it; a limit that isn't reached never pauses.
  await patchState((s) => {
    s.budget = { monthlyLimit: 1000, pauseAtLimit: true, notified: null, resumedMonth: null, updatedAt: null };
  });
  await lifecycle.reap();
  assert.equal(budget.currentBudgetStatus()?.level, "ok");
  await patchState((s) => {
    delete s.budget;
  });
  await lifecycle.reap();
  assert.equal(budget.currentBudgetStatus()?.level, "off");

  // ── Awake hours ────────────────────────────────────────────────────────────────────────────
  gate.state = "asleep";
  gate.keepAwake.length = 0;
  await patchState((s) => {
    s.schedules = { windows: [{ id: "window-001", repository: "*", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", timezone: "UTC" }], updatedAt: now };
  });
  const open = await lifecycle.applyScheduling();
  assert.equal(open.told, 1);
  assert.equal(gate.keepAwake.length, 1);
  assert.ok(Date.parse(gate.keepAwake[0]!) > Date.now(), "the gate is held awake until the window's end");
  assert.equal(gate.state, "awake", "and a sleeping preview is started");
  const held = await get();
  assert.equal(held.scheduleHoldUntil, gate.keepAwake[0]);
  assert.equal((await lifecycle.applyScheduling()).told, 0, "no change, so the gate isn't told again");
  // The window goes away: the gate is released, and a person's own keep-awake would still hold it.
  await patchState((s) => {
    delete s.schedules;
  });
  assert.equal((await lifecycle.applyScheduling()).told, 1);
  assert.equal(gate.keepAwake.at(-1), null);
  assert.equal((await get()).scheduleHoldUntil, null);
  await patchState((s) => {
    const e = s.environments[0];
    e.keepAwakeUntil = new Date(Date.now() + 3_600_000).toISOString();
    e.scheduleHoldUntil = new Date(Date.now() + 1_800_000).toISOString();
  });
  const personal = (await get()).keepAwakeUntil;
  const off = await lifecycle.keepAwakeOffEnvironment("env-1");
  assert.ok(off.ok);
  assert.ok(gate.keepAwake.at(-1) !== null, "turning off keep-awake leaves the schedule's hold in place");
  assert.ok(Date.parse(gate.keepAwake.at(-1)!) < Date.parse(personal!));
  await patchState((s) => {
    s.environments[0].scheduleHoldUntil = null;
  });

  // ── Pre-wake ───────────────────────────────────────────────────────────────────────────────
  const badWake = await lifecycle.setScheduledWake("env-1", { at: "2020-01-01T00:00:00Z", minutes: 30 });
  assert.ok(!badWake.ok && badWake.code === "invalid");
  assert.ok(!(await lifecycle.setScheduledWake("nope", { at: now, minutes: 30 })).ok);
  gate.state = "asleep";
  const set = await lifecycle.setScheduledWake("env-1", { at: new Date(Date.now() + 1500).toISOString(), minutes: 30 });
  assert.ok(set.ok);
  gate.keepAwake.length = 0;
  assert.equal((await lifecycle.applyScheduling()).told, 0, "not yet");
  await sleep(1700);
  assert.equal((await lifecycle.applyScheduling()).told, 1, "the gate is told when the time comes");
  assert.equal(gate.state, "awake", "and the preview is started");
  const woken = await get();
  assert.ok(woken.scheduledWake?.startedAt);
  assert.ok(woken.events?.some((event) => event.type === "scheduled_wake"));
  assert.ok(Math.abs(Date.parse(woken.scheduleHoldUntil!) - (Date.parse(woken.scheduledWake!.at) + 30 * 60_000)) < 1000);
  await lifecycle.setScheduledWake("env-1", null);
  assert.equal((await get()).scheduledWake, null);
  assert.equal((await lifecycle.applyScheduling()).told, 1);
  assert.equal((await get()).scheduleHoldUntil, null, "cancelling releases the hold");

  // ── Smoke test and comparison ─────────────────────────────────────────────────────────────
  const waitFor = async (check: (e: Awaited<ReturnType<typeof get>>) => boolean, ms = 20_000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      const current = await get();
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error("timed out waiting for the checks");
  };
  await patchState((s) => {
    s.previewSettings = { "acme/web": { vars: [], smoke: [{ path: "/", expectStatus: 200, contains: "Hello from the preview" }], productionUrl: `http://127.0.0.1:${port}/prod`, updatedAt: now } };
  });
  assert.ok((await lifecycle.recheckEnvironment("env-1", "both")).ok);
  const checked = await waitFor((e) => Boolean(e.checks) && Boolean(e.visual));
  assert.equal(checked.checks?.ok, true);
  assert.equal(checked.checks?.sha, SHA);
  assert.ok(checked.events?.some((event) => event.type === "checks"));
  const browser = findBrowser();
  if (browser) {
    assert.equal(checked.visual?.problem, undefined, `${checked.visual?.problem}`);
    assert.ok((checked.visual?.mismatchPercent ?? 0) > 50, "a red page against a cream one differs");
    for (const kind of ["preview", "production", "diff"]) assert.ok(existsSync(path.join(visualDir(path.join(dir, "data"), "env-1"), `${kind}.png`)), `${kind}.png saved`);
  } else {
    assert.match(checked.visual?.problem ?? "", /No browser/);
  }
  // The comment on the pull request carries the results.
  const comment = (await get()).comments.at(-1)?.body ?? "";
  assert.match(comment, /\*\*Smoke test\*\* \| Passed: GET \/ answered 200/);
  // A failing check says so.
  await patchState((s) => {
    s.previewSettings!["acme/web"].smoke = [{ path: "/", expectStatus: 200, contains: "Not on the page" }];
    delete s.previewSettings!["acme/web"].productionUrl;
  });
  assert.ok((await lifecycle.recheckEnvironment("env-1", "smoke")).ok);
  const failed = await waitFor((e) => e.checks?.ok === false);
  assert.match(failed.checks?.summary ?? "", /doesn't contain “Not on the page”/);

  // Only a running preview can be checked.
  await patchState((s) => {
    s.environments[0].status = "failed";
  });
  assert.ok(!(await lifecycle.recheckEnvironment("env-1", "both")).ok);

  server.closeAllConnections();
  server.close();
  console.log(`cost-control: ok${browser ? "" : " (no browser here: comparison reported that instead)"}`);
}

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    finish(1);
  });

function finish(code: number) {
  process.chdir(here);
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
