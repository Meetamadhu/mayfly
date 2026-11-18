/**
 * Unit checks for the Cost page's fleet numbers. Run: npx tsx scripts/test-fleet.ts
 */
import { fleetStats } from "../src/lib/fleet";
import type { Environment } from "../src/lib/types";

const now = Date.parse("2026-11-18T12:00:00Z");
const H = 3_600_000;
let n = 0;
function env(id: string, over: Partial<Environment>): Environment {
  return {
    id, repository: "acme/web", prNumber: Number(id.replace(/\D/g, "")) || 1, sha: "a", branch: "b",
    status: "ready", deploymentId: null, url: null, createdAt: new Date(now - H).toISOString(),
    updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + H).toISOString(),
    lastActiveAt: new Date(now).toISOString(), destroyedAt: null, destroyReason: null, error: null,
    updateGeneration: 1, comments: [], ...over,
  };
}
const at = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();
function check(cond: boolean, msg: string, detail?: unknown) {
  if (!cond) throw new Error(`FAIL ${msg} ${JSON.stringify(detail)}`);
  n += 1;
  console.log(`ok  ${msg}`);
}

const envs = [
  env("p1", { sleep: "awake" }),
  env("p2", { sleep: "asleep" }),
  env("p3", { sleep: "waking" }),
  // removed: lifespans 2 h, 4 h, 10 h (merged, closed, expired); manual 6 h; failed 0.1 h (left out of lifespan)
  env("r1", { status: "destroyed", createdAt: at(30), destroyedAt: at(28), destroyReason: "merged" }),
  env("r2", { status: "destroyed", createdAt: at(30), destroyedAt: at(26), destroyReason: "closed" }),
  env("r3", { status: "destroyed", createdAt: at(30), destroyedAt: at(20), destroyReason: "expired" }),
  env("r4", { status: "destroyed", createdAt: at(26), destroyedAt: at(20), destroyReason: "manual" }),
  env("r5", { status: "destroyed", createdAt: at(5), destroyedAt: at(4.9), destroyReason: "failed" }),
  // outside the 30-day window entirely
  env("old", { status: "destroyed", createdAt: at(24 * 40), destroyedAt: at(24 * 39), destroyReason: "merged" }),
  // demo is ignored
  env("demo", { repository: "acme/demo", sleep: "awake", createdAt: at(24 * 60) }),
];
const s = fleetStats(envs, { now, costPerHour: 0.05, isDemo: (e) => e.repository === "acme/demo" });

check(s.awakeNow === 2 && s.asleepNow === 1, "awake counts waking, demo left out", s);
check(Math.abs(s.burnPerHour - 0.1) < 1e-9, "cost per hour = awake × rate", s.burnPerHour);
check(s.created === 8, "previews opened in 30 days (old and demo left out)", s.created);
check(s.removed === 5, "removed in window", s.removed);
check(s.reasons.merged === 1 && s.reasons.manual === 1 && s.reasons.failed === 1, "reasons counted", s.reasons);
check(s.automaticShare === 4 / 5, "automatic share leaves out manual", s.automaticShare);
check(s.lifespanCount === 4, "failed build left out of lifespan", s.lifespanCount);
check(s.averageLifespanMs === (2 + 4 + 10 + 6) / 4 * H, "average lifespan", s.averageLifespanMs! / H);
check(s.medianLifespanMs === 5 * H, "median of an even count", s.medianLifespanMs! / H);
// at 30h ago r1,r2,r3 open (3); r4 opens at 26h when r2 closes at 26h → still 3; p1-p3 open 1h ago when nothing else → 3
check(s.peak === 3, "peak: a removal and an opening at the same instant don't stack", s.peak);

const touching = [
  env("a", { status: "destroyed", createdAt: at(10), destroyedAt: at(5), destroyReason: "closed" }),
  env("b", { status: "destroyed", createdAt: at(5), destroyedAt: at(2), destroyReason: "closed" }),
];
check(fleetStats(touching, { now, costPerHour: 1, isDemo: () => false }).peak === 1, "back-to-back previews peak at 1");
const empty = fleetStats([], { now, costPerHour: 1, isDemo: () => false });
check(empty.peak === 0 && empty.averageLifespanMs === null && empty.automaticShare === null, "empty fleet", empty);

console.log(`\n${n} checks passed`);
