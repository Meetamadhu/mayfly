/**
 * The Preview details panel's status card: sleep countdown, keep-awake, build progress, removed wording, and the
 * ?preview= address. Run with: npx tsx scripts/test-preview-details.ts
 */
import assert from "node:assert/strict";
import type { Environment } from "../src/lib/types";

async function main() {
  const d = await import("../src/lib/preview-details");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const now = Date.parse("2026-11-24T06:00:00Z");
  const min = 60_000;
  const env = (over: Partial<Environment>): Environment =>
    ({
      id: "e1", repository: "acme/web", prNumber: 42, sha: "a".repeat(40), branch: "feat/export", status: "ready", sleep: "awake",
      deploymentId: "d1", url: "http://x/p/acme/web/42", createdAt: "2026-11-23T06:00:00Z", updatedAt: "2026-11-24T05:50:00Z",
      expiresAt: "2026-11-26T06:00:00Z", lastActiveAt: new Date(now - 12 * min).toISOString(), destroyedAt: null, destroyReason: null,
      error: null, updateGeneration: 1, comments: [], sleepSeconds: 1800, events: [], ...over,
    }) as Environment;
  const opts = { fallbackSleepSeconds: 1800, usualBuildMs: 14_000 };

  check("awake: sleeps in the idle time left, bar shows what's left", () => {
    const card = d.statusCard(env({}), now, opts);
    assert.equal(card.state, "awake");
    assert.equal(card.line, "sleeps in 18 min if nobody visits");
    assert.equal(card.progress, 0.6);
  });

  check("awake past its idle time says it's going to sleep", () => {
    const card = d.statusCard(env({ lastActiveAt: new Date(now - 40 * min).toISOString() }), now, opts);
    assert.equal(card.line, "going to sleep now");
    assert.equal(card.progress, 0);
  });

  check("kept awake: until when, and how much is left", () => {
    const start = new Date(now - 30 * min).toISOString();
    const until = new Date(now + 90 * min).toISOString();
    const card = d.statusCard(env({ keepAwakeUntil: until, events: [{ at: start, type: "keep_awake", detail: until }] }), now, opts);
    assert.equal(card.state, "kept");
    assert.match(card.line, /1 h 30 min from now$/);
    assert.equal(card.progress, 0.75);
  });

  check("an expired keep-awake counts as plain awake", () => {
    assert.equal(d.detailState(env({ keepAwakeUntil: new Date(now - min).toISOString() }), now), "awake");
  });

  check("asleep, building, failed and removed", () => {
    assert.equal(d.statusCard(env({ sleep: "asleep" }), now, opts).label, "Asleep");
    const building = d.statusCard(
      env({ status: "provisioning", events: [{ at: new Date(now - 7000).toISOString(), type: "build_started" }] }),
      now,
      opts,
    );
    assert.equal(building.line, "about 7 s left");
    assert.equal(building.progress, 0.5);
    assert.equal(d.statusCard(env({ status: "failed" }), now, opts).label, "Couldn’t build");
    const removed = d.statusCard(env({ status: "destroyed", destroyReason: "merged", destroyedAt: "2026-11-20T10:00:00Z" }), now, opts);
    assert.equal(removed.state, "removed");
    assert.match(removed.line, /^after the pull request was merged on /);
  });

  check("build time comes from the record or the latest built event", () => {
    assert.equal(d.lastBuildMs(env({ buildMs: 9000 })), 9000);
    assert.equal(d.lastBuildMs(env({ events: [{ at: "2026-11-23T06:00:15Z", type: "built", detail: "14" }] })), 14000);
    assert.equal(d.lastBuildMs(env({})), null);
    assert.equal(d.usualBuildMs([env({ buildMs: 9000 }), env({ buildMs: 20000 }), env({ buildMs: 14000 })]), 14000);
  });

  check("when it's removed", () => {
    assert.equal(d.endsText(env({}), now), "in 2 days");
    assert.equal(d.endsText(env({ expiresAt: new Date(now + 3 * 60 * min).toISOString() }), now), "in 3 h");
  });

  check("?preview= accepts only plain ids", () => {
    assert.equal(d.previewIdFromSearch("?preview=abc-123_X"), "abc-123_X");
    assert.equal(d.previewIdFromSearch("?preview=../../etc"), null);
    assert.equal(d.previewIdFromSearch("?q=x"), null);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
