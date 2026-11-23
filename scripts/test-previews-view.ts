/**
 * The redesigned Previews page's logic: PR titles from GitHub, sorting, the number-card hints, repo avatars and the
 * Building tab. Run with: npx tsx scripts/test-previews-view.ts
 */
import assert from "node:assert/strict";
import type { Environment } from "../src/lib/types";

async function main() {
  const { cleanTitle } = await import("../src/lib/github");
  const view = await import("../src/components/previews-view");
  const { matchesBoardFilter } = await import("../src/components/board-parts");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const now = Date.parse("2026-11-23T12:00:00Z");
  const env = (over: Partial<Environment>): Environment =>
    ({
      id: Math.random().toString(36).slice(2),
      repository: "acme/web",
      prNumber: 1,
      sha: "a".repeat(40),
      branch: "main",
      status: "ready",
      deploymentId: "d",
      url: "http://x/p/acme/web/1",
      createdAt: "2026-11-23T10:00:00Z",
      updatedAt: "2026-11-23T10:00:00Z",
      expiresAt: "2026-11-23T18:00:00Z",
      lastActiveAt: "2026-11-23T11:55:00Z",
      destroyedAt: null,
      destroyReason: null,
      error: null,
      updateGeneration: 1,
      comments: [],
      ...over,
    }) as Environment;

  check("PR titles are tidied and capped", () => {
    assert.equal(cleanTitle("  Add   billing\nexport "), "Add billing export");
    assert.equal(cleanTitle("x".repeat(300))?.length, 200);
    assert.equal(cleanTitle(""), undefined);
    assert.equal(cleanTitle(42), undefined);
  });

  check("sorting: last visit, newest, ends soonest", () => {
    const a = env({ prNumber: 1, lastActiveAt: "2026-11-23T11:00:00Z", createdAt: "2026-11-23T09:00:00Z", expiresAt: "2026-11-23T20:00:00Z" });
    const b = env({ prNumber: 2, lastActiveAt: "2026-11-23T11:50:00Z", createdAt: "2026-11-23T08:00:00Z", expiresAt: "2026-11-23T13:00:00Z" });
    const c = env({ prNumber: 3, lastActiveAt: "2026-11-23T10:00:00Z", createdAt: "2026-11-23T11:00:00Z", expiresAt: "2026-11-23T15:00:00Z" });
    const order = (list: Environment[]) => list.map((item) => item.prNumber).join(",");
    assert.equal(order(view.sortPreviews([a, b, c], "visit")), "2,1,3");
    assert.equal(order(view.sortPreviews([a, b, c], "newest")), "3,1,2");
    assert.equal(order(view.sortPreviews([a, b, c], "expiring")), "2,3,1");
  });

  check("awake card: 'sleeps in' range from last visits and sleep times", () => {
    const list = [
      env({ sleep: "awake", lastActiveAt: "2026-11-23T11:58:00Z", sleepSeconds: 600 }), // 8 min left
      env({ sleep: "awake", lastActiveAt: "2026-11-23T11:55:00Z", sleepSeconds: 600 }), // 5 min left
      env({ sleep: "asleep" }),
    ];
    assert.equal(view.sleepsInRange(list, 600, now), "sleeps in 5–8 min");
    assert.equal(view.sleepsInRange([list[0]], 600, now), "sleeps in 8 min");
    assert.equal(view.sleepsInRange([list[2]], 600, now), null);
    const kept = env({ sleep: "awake", keepAwakeUntil: "2026-11-23T14:00:00Z" });
    assert.equal(view.sleepsInRange([kept], 600, now), null, "kept awake: no countdown");
  });

  check("building card: the usual build time", () => {
    assert.equal(view.usualBuild([env({ buildMs: 12_000 }), env({ buildMs: 14_200 }), env({ buildMs: 90_000 })]), "usually 14 s");
    assert.equal(view.usualBuild([env({ buildMs: 300_000 })]), "usually 5 min");
    assert.equal(view.usualBuild([env({})]), null);
  });

  check("repo avatars: same repo, same letter and colour", () => {
    const one = view.repoAvatar("acme/web");
    assert.equal(one.letter, "W");
    assert.deepEqual(view.repoAvatar("acme/web"), one);
    assert.equal(view.repoAvatar("acme/api").letter, "A");
  });

  check("the Building tab", () => {
    assert.equal(matchesBoardFilter(env({ status: "provisioning" }), "building", now, null), true);
    assert.equal(matchesBoardFilter(env({ status: "updating" }), "building", now, null), true);
    assert.equal(matchesBoardFilter(env({ status: "ready" }), "building", now, null), false);
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
