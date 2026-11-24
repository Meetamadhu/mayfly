/**
 * The Admin page's Recent activity sheet: row wording, PR comments as notes, tabs, groups, short times and
 * unread. Run with: npx tsx scripts/test-recent-activity.ts
 */
import assert from "node:assert/strict";
import type { Environment, EnvironmentEvent } from "../src/lib/types";

async function main() {
  const r = await import("../src/lib/recent-activity");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const now = Date.parse("2026-11-24T12:00:00Z");
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const ev = (at: string, type: string, detail?: string): EnvironmentEvent => ({ at, type, ...(detail ? { detail } : {}) });
  const env = (over: Partial<Environment>): Environment =>
    ({
      id: "e1", repository: "acme/storefront", prNumber: 12, sha: "a".repeat(40), branch: "x", status: "ready", sleep: "awake",
      deploymentId: "d", url: "http://x", createdAt: ago(600), updatedAt: ago(1), expiresAt: ago(-600), lastActiveAt: ago(1),
      destroyedAt: null, destroyReason: null, error: null, updateGeneration: 1, comments: [], events: [], ...over,
    }) as Environment;

  check("comments read as plain notes", () => {
    assert.equal(r.noteText("**Mayfly preview ready**\n\n[Open preview](https://x/p/a/b/1)"), "Mayfly preview ready");
    assert.equal(r.noteText("<!-- mayfly -->\n## Preview updated: https://x/p/1"), "Preview updated");
    assert.equal(r.noteText("**Mayfly couldn't build this preview**"), "Mayfly couldn't build this preview");
  });

  const a = env({
    events: [ev(ago(400), "opened"), ev(ago(399), "build_started"), ev(ago(398), "built", "14"), ev(ago(398), "ready"), ev(ago(5), "updated", "4f2a9c1"), ev(ago(2), "visited")],
    comments: [{ at: ago(397), body: "**Mayfly preview ready**\n\n[Open preview](https://x)" }],
  });
  const b = env({ id: "e2", repository: "acme/payments-api", prNumber: 4, status: "destroyed", events: [ev(ago(130), "woke", "2"), ev(ago(60 * 30), "destroyed", "merged")] });
  const items = r.recentItems([a, b], null);

  check("rows: newest first, one row per build, notes included", () => {
    assert.deepEqual(
      items.map((item) => `${item.subject} · ${item.label}`),
      [
        "acme/storefront #12 · Visit",
        "acme/storefront #12 · Updated",
        "acme/payments-api #4 · Visit",
        "acme/storefront #12 · Note",
        "acme/storefront #12 · Built",
        "acme/storefront #12 · Created",
        "acme/payments-api #4 · Removed",
      ],
    );
    assert.equal(items.find((item) => item.kind === "note")?.detail, "“Mayfly preview ready”");
    assert.equal(items.find((item) => item.kind === "removed")?.detail, "the pull request was merged");
  });

  check("tabs", () => {
    assert.equal(items.filter((item) => r.inTab(item, "visits")).length, 2);
    assert.equal(items.filter((item) => r.inTab(item, "updates")).length, 4);
    assert.equal(items.filter((item) => r.inTab(item, "removed")).length, 1);
  });

  check("groups and short times", () => {
    assert.equal(r.recentGroup(ago(2), now), "Just now");
    assert.equal(r.recentGroup(ago(130), now), "Today");
    assert.equal(r.recentGroup(ago(60 * 30), now), "Earlier");
    assert.equal(r.shortAgo(ago(0.5), now), "now");
    assert.equal(r.shortAgo(ago(1), now), "1m");
    assert.equal(r.shortAgo(ago(121), now), "2h 1m");
    assert.equal(r.shortAgo(ago(60 * 50), now), "2d");
  });

  check("unread: the last day until marked read, then only newer items", () => {
    const first = r.readSince(null, now);
    assert.equal(items.filter((item) => r.isUnread(item, first)).length, 6);
    const marked = r.readSince(ago(3), now);
    assert.equal(items.filter((item) => r.isUnread(item, marked)).length, 1);
  });

  check("the demo is named as the demo", () => {
    const demo = r.recentItems([env({ repository: "mayfly/demo", prNumber: 1, events: [ev(ago(1), "visited")] })], "mayfly/demo#1");
    assert.equal(demo[0].subject, "Demo preview");
  });

  const { withoutVisitNearWake } = await import("../src/lib/timeline");
  check("a visit within 2 minutes of a wake is dropped, others stay", () => {
    const wake = Date.parse(ago(10));
    const kept = withoutVisitNearWake([ev(ago(11), "visited"), ev(ago(40), "visited"), ev(ago(10), "woke")], wake);
    assert.deepEqual(kept.map((e) => e.type), ["visited", "woke"]);
    assert.equal(kept[0].at, ago(40));
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
