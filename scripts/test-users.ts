/**
 * Team accounts on their own: password hashing, sign-up rules, sign-in states, session cookies (tampered,
 * expired, signed out), admin actions and the activity log. Run with: npx tsx scripts/test-users.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.chdir(mkdtempSync(path.join(tmpdir(), "mayfly-users-")));
delete process.env.MONGODB_URI;
process.env.MAYFLY_ADMIN_TOKEN = "test-admin-token-".padEnd(40, "x");

async function main() {
  const users = await import("../src/lib/users");
  const store = await import("../src/lib/store");
  const records = await import("../src/lib/account-records");
  let passed = 0;
  const check = async (name: string, fn: () => unknown) => {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      console.error(`FAILED: ${name}`);
      throw error;
    }
  };

  await check("passwords are stored as scrypt hashes that verify", async () => {
    const hash = await users.hashPassword("correct horse battery");
    assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!hash.includes("correct horse"));
    assert.equal(await users.verifyPassword("correct horse battery", hash), true);
    assert.equal(await users.verifyPassword("correct horse batterY", hash), false);
    assert.notEqual(hash, await users.hashPassword("correct horse battery"), "each hash has its own salt");
  });
  await check("a broken or hostile hash string never verifies", async () => {
    for (const bad of ["", "plain", "scrypt$1$1$1$a$b", "scrypt$99999999$8$1$AAAA$AAAA", "bcrypt$x$y$z$a$b"]) {
      assert.equal(await users.verifyPassword("anything", bad), false, bad);
    }
  });

  await check("usernames are checked and lower-cased", () => {
    assert.deepEqual(users.checkUsername("  User_1 "), { ok: true, username: "user_1" });
    for (const bad of ["ab", "-abc", "a b c", "x".repeat(33), "user!", "", 42]) assert.equal(users.checkUsername(bad).ok, false, String(bad));
    assert.match((users.checkUsername("Admin") as { error: string }).error, /reserved/);
  });
  await check("passwords need 10 to 200 characters", () => {
    assert.equal(users.checkPassword("123456789").ok, false);
    assert.equal(users.checkPassword("1234567890").ok, true);
    assert.equal(users.checkPassword("x".repeat(201)).ok, false);
  });

  await check("sign-up creates a waiting account and never returns the hash", async () => {
    const result = await users.signUp("User1", "first-password");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.user.username, "user1");
    assert.equal(result.user.status, "pending");
    assert.ok(!("passwordHash" in result.user));
    assert.ok(!JSON.stringify(await users.listUsers()).includes("scrypt"));
  });
  await check("a taken username is refused, in any letter case", async () => {
    const again = await users.signUp("USER1", "another-password");
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.code, "taken");
  });

  await check("a waiting account can't sign in, but is told why only with the right password", async () => {
    const right = await users.signInUser("user1", "first-password");
    assert.equal(!right.ok && right.code, "pending");
    const wrong = await users.signInUser("user1", "wrong-password");
    assert.equal(!wrong.ok && wrong.code, "wrong");
    const nobody = await users.signInUser("nobody", "first-password");
    assert.equal(!nobody.ok && nobody.code, "wrong");
  });

  const id = (await users.listUsers())[0].id;
  await check("approving lets them sign in and records the time", async () => {
    const approved = await users.changeUser(id, "approve");
    assert.equal(approved.ok, true);
    const result = await users.signInUser("User1", "first-password");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok((await users.listUsers())[0].lastSignInAt);
    assert.equal((await users.userFromSession(result.cookie))?.username, "user1");
  });
  await check("approving twice is refused", async () => {
    assert.equal((await users.changeUser(id, "approve")).ok, false);
  });

  const good = await users.signInUser("user1", "first-password");
  assert.ok(good.ok);
  const cookie = good.ok ? good.cookie : "";

  await check("a tampered session cookie is refused", async () => {
    const [uid, version, expiry, mac] = cookie.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
    for (const bad of [
      `${uid}.${version}.${expiry}.${flipped}`,
      `${uid}.${Number(version) + 1}.${expiry}.${mac}`,
      `${uid}.${version}.${Number(expiry) + 999}.${mac}`,
      "",
      "a.b.c",
      `${cookie}.extra`,
    ]) {
      assert.equal(await users.userFromSession(bad), null, bad);
    }
  });
  await check("an expired session is refused", async () => {
    const old = users.issueUserSession({ id, sessionVersion: 0 }, Date.now() - 13 * 60 * 60 * 1000);
    assert.equal(await users.userFromSession(old), null);
  });
  await check("changing the admin token signs every user out", async () => {
    const saved = process.env.MAYFLY_ADMIN_TOKEN;
    process.env.MAYFLY_ADMIN_TOKEN = "a-different-admin-token-xxxxxxxxxxxxxxxx";
    assert.equal(await users.userFromSession(cookie), null);
    process.env.MAYFLY_ADMIN_TOKEN = "";
    assert.equal(await users.userFromSession(cookie), null, "no admin token, no user sessions");
    process.env.MAYFLY_ADMIN_TOKEN = saved;
    assert.ok(await users.userFromSession(cookie));
  });
  await check("signing a user out ends their existing session", async () => {
    await users.changeUser(id, "signout");
    assert.equal(await users.userFromSession(cookie), null);
  });
  await check("turning an account off ends sessions and blocks sign-in until turned on", async () => {
    const fresh = await users.signInUser("user1", "first-password");
    assert.ok(fresh.ok);
    await users.changeUser(id, "disable");
    assert.equal(await users.userFromSession(fresh.ok ? fresh.cookie : ""), null);
    const blocked = await users.signInUser("user1", "first-password");
    assert.equal(!blocked.ok && blocked.code, "disabled");
    await users.changeUser(id, "enable");
    assert.equal((await users.signInUser("user1", "first-password")).ok, true);
  });
  await check("removing an account deletes it", async () => {
    await users.changeUser(id, "remove");
    assert.equal((await users.listUsers()).length, 0);
    assert.equal((await users.changeUser(id, "approve")).ok, false);
  });

  await check(`no more than ${users.MAX_PENDING} sign-ups can wait at once`, async () => {
    for (let i = 0; i < users.MAX_PENDING; i += 1) {
      assert.equal((await users.signUp(`wait${i}`, "some-password")).ok, true);
    }
    const extra = await users.signUp("one-too-many", "some-password");
    assert.equal(!extra.ok && extra.code, "too_many_pending");
  });

  await check("the activity log keeps the newest entries, newest first", async () => {
    for (let i = 0; i < records.AUDIT_KEEP + 5; i += 1) {
      const state = await store.loadState();
      state.audit = [...(state.audit ?? []), { at: new Date(1_700_000_000_000 + i * 1000).toISOString(), actor: "admin", role: "admin" as const, action: "x", target: `#${i}`, detail: null }];
      await store.saveState(state);
    }
    await users.recordAudit({ name: "user1", role: "user" }, "preview.extend", "acme/web #3", "by 4 h");
    const state = await store.loadState();
    assert.equal(state.audit?.length, records.AUDIT_KEEP);
    const newest = (await users.listAudit(2))[0];
    assert.deepEqual(
      { actor: newest.actor, action: newest.action, target: newest.target, detail: newest.detail },
      { actor: "user1", action: "preview.extend", target: "acme/web #3", detail: "by 4 h" },
    );
  });

  await check("saved accounts and log survive a save by other code, and bad records are dropped", async () => {
    const state = await store.loadState();
    const before = state.users?.length ?? 0;
    state.environments = [];
    await store.saveState(state);
    assert.equal((await store.loadState()).users?.length, before);
    const kept = records.asUsers([
      { id: "a", username: "ok_name", passwordHash: "scrypt$1$1$1$a$b", status: "active", createdAt: new Date().toISOString() },
      { id: "b", username: "ok_name", passwordHash: "scrypt$1$1$1$a$b", status: "active", createdAt: new Date().toISOString() },
      { id: "c", username: "Bad Name", passwordHash: "scrypt$x", status: "active", createdAt: new Date().toISOString() },
      { id: "d", username: "plain", passwordHash: "plaintext", status: "active", createdAt: new Date().toISOString() },
      { id: "e", username: "weird", passwordHash: "scrypt$x", status: "superuser", createdAt: new Date().toISOString() },
    ]);
    assert.deepEqual(kept?.map((u) => u.id), ["a"]);
  });

  await check("preview apps never receive Mayfly's sign-in cookies, but keep their own", async () => {
    const { forwardableCookie } = await import("../src/lib/preview-proxy");
    assert.equal(forwardableCookie(undefined), undefined);
    assert.equal(forwardableCookie("mayfly_admin=abc"), undefined);
    assert.equal(forwardableCookie("mayfly_user=a.b.c.d; mayfly_admin=x"), undefined);
    assert.equal(forwardableCookie("theme=dark; mayfly_user=a.b.c.d; cart=3"), "theme=dark; cart=3");
    assert.equal(forwardableCookie(["a=1; mayfly_admin=x", "b=2"]), "a=1; b=2");
    assert.equal(forwardableCookie("mayfly_user_extra=keep; xmayfly_admin=keep"), "mayfly_user_extra=keep; xmayfly_admin=keep");
    assert.equal(forwardableCookie(" mayfly_admin =x;  ok=1 "), "ok=1");
  });

  console.log(`${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
