/**
 * Team password for previews (PREVIEW_PASSWORD): the access cookie, safe redirects, wrong-guess limits, the page,
 * and that the cookie never reaches a preview app. Run with: npx tsx scripts/test-preview-access.ts
 */
import assert from "node:assert/strict";

async function main() {
  const access = await import("../src/lib/preview-access");
  const { forwardableCookie } = await import("../src/lib/preview-proxy");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const env = process.env as Record<string, string | undefined>;

  check("no password: everyone sees previews", () => {
    delete env.PREVIEW_PASSWORD;
    assert.equal(access.previewsProtected(), false);
    assert.equal(access.hasPreviewAccess({ method: "GET", headers: {} }), true);
  });

  check("with a password: no cookie, no access", () => {
    env.PREVIEW_PASSWORD = "team-secret-123";
    assert.equal(access.previewsProtected(), true);
    assert.equal(access.hasPreviewAccess({ method: "GET", headers: {} }), false);
  });

  check("a valid cookie lets the browser in", () => {
    const value = access.issueAccessValue("team-secret-123");
    const headers = { cookie: `other=1; ${access.PREVIEW_ACCESS_COOKIE}=${value}` };
    assert.equal(access.hasPreviewAccess({ method: "GET", headers }), true);
  });

  check("cookies expire, and changing the password signs everyone out", () => {
    const now = Date.now();
    const value = access.issueAccessValue("team-secret-123", now, 7);
    assert.equal(access.accessValueIsValid(value, "team-secret-123", now + 6 * 86_400_000), true);
    assert.equal(access.accessValueIsValid(value, "team-secret-123", now + 8 * 86_400_000), false);
    assert.equal(access.accessValueIsValid(value, "new-password-456", now), false);
    assert.equal(access.accessValueIsValid("123.abc", "team-secret-123", now), false);
    assert.equal(access.accessValueIsValid("garbage", "team-secret-123", now), false);
  });

  check("admins don't need the team password", () => {
    env.MAYFLY_ADMIN_TOKEN = "admin-token-for-tests";
    assert.equal(
      access.hasPreviewAccess({ method: "GET", headers: { authorization: "Bearer admin-token-for-tests" } }),
      true,
    );
    assert.equal(access.hasPreviewAccess({ method: "GET", headers: { authorization: "Bearer wrong" } }), false);
  });

  check("password comparison", () => {
    assert.equal(access.passwordMatches("team-secret-123", "team-secret-123"), true);
    assert.equal(access.passwordMatches("team-secret-12", "team-secret-123"), false);
    assert.equal(access.passwordMatches("anything", ""), false);
  });

  check("after the password, only preview paths are allowed as the next page", () => {
    assert.equal(access.safeNext("/p/acme/web/42/"), "/p/acme/web/42/");
    assert.equal(access.safeNext("/p/acme/web/42/checkout?x=1"), "/p/acme/web/42/checkout?x=1");
    assert.equal(access.safeNext("/p/acme/web/42"), "/p/acme/web/42");
    assert.equal(access.safeNext("https://evil.example/p/a/b/1"), null);
    assert.equal(access.safeNext("//evil.example/p/a/b/1"), null);
    assert.equal(access.safeNext("/admin"), null);
    assert.equal(access.safeNext("/p/acme/web/notanumber"), null);
    assert.equal(access.safeNext(undefined), null);
  });

  check("20 wrong guesses in 15 minutes locks that address out for a while", () => {
    access.resetTriesForTests();
    const now = 1_000_000;
    for (let i = 0; i < 19; i++) access.recordWrongTry("1.2.3.4", now);
    assert.equal(access.tooManyTries("1.2.3.4", now), false);
    access.recordWrongTry("1.2.3.4", now);
    assert.equal(access.tooManyTries("1.2.3.4", now), true);
    assert.equal(access.tooManyTries("5.6.7.8", now), false, "other addresses unaffected");
    assert.equal(access.tooManyTries("1.2.3.4", now + 16 * 60_000), false, "the window passes");
  });

  check("the page escapes what it shows", () => {
    const html = access.passwordPage({ repository: 'acme/<script>"x"', pr: "7", next: '/p/a/b/7/"><img>' });
    assert.ok(!html.includes("<script>\""), "no raw script tag");
    assert.ok(html.includes("acme/&lt;script&gt;&quot;x&quot;"));
    assert.ok(html.includes('value="/p/a/b/7/&quot;&gt;&lt;img&gt;"'));
    assert.ok(!html.includes("<script"), "the page itself has no scripts");
  });

  check("the access cookie is never passed on to a preview app", () => {
    const value = access.issueAccessValue("team-secret-123");
    const forwarded = forwardableCookie(`theme=dark; ${access.PREVIEW_ACCESS_COOKIE}=${value}; cart=3`);
    assert.equal(forwarded, "theme=dark; cart=3");
  });

  delete env.PREVIEW_PASSWORD;
  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
