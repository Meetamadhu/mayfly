/**
 * Feedback logic without a server: the link key, reading a comment, the GitHub note, page matching and pins.
 * Run with: npx tsx scripts/test-feedback-unit.ts
 */
import assert from "node:assert/strict";

async function main() {
  const fb = await import("../src/lib/feedback");
  const review = await import("../src/lib/review");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  check("the key is per preview, changes with the admin token, and is off without one", () => {
    const a = fb.feedbackKey("env-1", "token-a");
    assert.match(a ?? "", /^[0-9a-f]{32}$/);
    assert.notEqual(a, fb.feedbackKey("env-2", "token-a"));
    assert.notEqual(a, fb.feedbackKey("env-1", "token-b"));
    assert.equal(fb.feedbackKey("env-1", ""), null);
    assert.equal(fb.feedbackKeyMatches("env-1", a ?? "", "token-a"), true);
    assert.equal(fb.feedbackKeyMatches("env-2", a ?? "", "token-a"), false);
    assert.equal(fb.feedbackKeyMatches("env-1", "", "token-a"), false);
  });

  check("a comment is tidied and checked", () => {
    const ok = fb.parseFeedback({ author: "  Priya \n K ", body: "Line one\r\n\n\n\nLine two\u0007", path: "/a?b=1", x: 10.6, y: -5, w: 1e9, h: 4, viewportWidth: 390 });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.input.author, "Priya K");
    assert.equal(ok.input.body, "Line one\n\nLine two");
    assert.deepEqual([ok.input.x, ok.input.y, ok.input.w, ok.input.h], [11, 0, 100000, 4]);
    assert.equal(fb.parseFeedback({ author: "A", body: "x".repeat(1001), x: 0, y: 0, w: 0, h: 0 }).ok, false);
    assert.equal(fb.parseFeedback({ author: "A", body: "x", x: "1", y: 0, w: 0, h: 0 }).ok, false);
    assert.equal(fb.parseFeedback({ author: "A".repeat(41), body: "x", x: 0, y: 0, w: 0, h: 0 }).ok, false);
  });

  check("page paths stay inside the preview", () => {
    assert.equal(fb.cleanPath("https://evil.example/"), "/");
    assert.equal(fb.cleanPath("//evil.example/"), "/");
    assert.equal(fb.cleanPath("/ok\npath"), "/ok path");
    assert.equal(fb.cleanPath(42), "/");
  });

  check("the GitHub note quotes the comment and can't ping or inject", () => {
    const note = fb.feedbackNote(
      { id: "abc", at: "", author: "**Sam** @boss", body: "Fix this\n@team <script>", path: "/x`y", x: 0, y: 0, w: 0, h: 0, viewportWidth: 0, sha: "1234567890abcdef" },
      "https://m.example/review/a/b/1?key=k",
    );
    assert.ok(note.startsWith("**Feedback from Sam @​boss** on `/x'y`"), note);
    assert.ok(note.includes("> Fix this\n> @​team &lt;script&gt;"), note);
    assert.ok(note.includes("[See it on the preview](https://m.example/review/a/b/1?key=k#c-abc) · commit `12345678`"), note);
    assert.ok(!fb.feedbackNote({ id: "a", at: "", author: "A", body: "b", path: "/", x: 0, y: 0, w: 0, h: 0, viewportWidth: 0, sha: "s" }, null).includes("See it"));
  });

  check("pages match without a trailing slash, with the query, without the hash", () => {
    assert.equal(review.samePage("/checkout/", "/checkout"), true);
    assert.equal(review.samePage("/checkout?a=1", "/checkout?a=2"), false);
    assert.equal(review.samePage("/checkout#top", "/checkout"), true);
    assert.equal(review.samePage("/", ""), true);
    assert.equal(review.frameAddress("/p/a/b/1/", "/checkout?x=1"), "/p/a/b/1/checkout?x=1");
    assert.equal(review.frameAddress("/p/a/b/1", "/"), "/p/a/b/1/");
    assert.equal(review.reviewPath("acme/web", 4), "/review/acme/web/4");
  });

  check("pins: numbered oldest first, only this page, grey when from an older commit", () => {
    const base = { author: "A", body: "b", w: 0, h: 0, viewportWidth: 0 };
    const items = [
      { ...base, id: "late", at: "2026-11-25T10:02:00Z", path: "/", x: 3, y: 3, sha: "new" },
      { ...base, id: "early", at: "2026-11-25T10:00:00Z", path: "/", x: 1, y: 1, sha: "old" },
      { ...base, id: "other", at: "2026-11-25T10:01:00Z", path: "/cart", x: 2, y: 2, sha: "new" },
    ];
    const pins = review.pinsFor(items, "/", "new");
    assert.deepEqual(pins.map((pin) => [pin.id, pin.n, pin.old]), [["early", 1, true], ["late", 3, false]]);
    assert.deepEqual(review.pinsFor(items, null, "new"), []);
    assert.deepEqual(review.commentNotes({ ...items[1], viewportWidth: 390 }, { sha: "new", showPage: true }), ["/", "on an older commit (old)", "on a 390 px wide screen"]);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
