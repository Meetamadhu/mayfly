/**
 * Preview settings logic without a server: encryption, names, saving rules, what the page sees, .env pasting, and
 * hiding build values in logs. Run with: npx tsx scripts/test-preview-settings-unit.ts
 */
import assert from "node:assert/strict";

async function main() {
  const ps = await import("../src/lib/preview-settings");
  const shape = await import("../src/lib/preview-settings-shape");
  const { parseDotEnv } = await import("../src/lib/dotenv");
  const { hideValues, buildArgs } = await import("../src/lib/builder");
  const KEY = "k".repeat(40);
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  check("values are encrypted, readable with the key and not without it", () => {
    const stored = ps.encryptValue("postgres://user:pw@db/test", KEY);
    assert.ok(stored.startsWith("v1.") && !stored.includes("postgres"));
    assert.notEqual(stored, ps.encryptValue("postgres://user:pw@db/test", KEY), "a fresh IV each time");
    assert.equal(ps.decryptValue(stored, KEY), "postgres://user:pw@db/test");
    assert.equal(ps.decryptValue(stored, "x".repeat(40)), null);
    assert.equal(ps.decryptValue(stored, ""), null);
    assert.equal(ps.decryptValue("v1.bad.bad.bad", KEY), null);
    assert.throws(() => ps.encryptValue("x", "short"));
    assert.equal(ps.secretsKeyConfigured("short"), false);
  });

  check("names Mayfly or Docker rely on are refused", () => {
    for (const name of ["PORT", "port", "HOST", "PATH", "HOME", "DOCKER_HOST", "PREVIEW_PR", "MAYFLY_ADMIN_TOKEN", "LD_PRELOAD", "https_proxy", "NO_PROXY", "XDG_CONFIG_HOME", "1ABC", "A-B", ""]) {
      assert.notEqual(ps.nameProblem(name), null, name);
    }
    for (const name of ["DATABASE_URL", "NEXT_PUBLIC_API", "stripe_key", "_PRIVATE", "GOOGLE_API_KEY", "NODE_OPTIONS"]) {
      assert.equal(ps.nameProblem(name), null, name);
    }
  });

  check("saving: new values are encrypted, empty keeps, missing removes, duplicates and no key refused", () => {
    const first = ps.applySettingsUpdate(
      { size: "large", vars: [{ name: "API_KEY", value: "abc" }, { name: "NEXT_PUBLIC_URL", value: "https://x", build: true }] },
      undefined,
      { now: "2026-11-25T00:00:00Z", key: KEY },
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.settings.size, "large");
    assert.equal(ps.decryptValue(first.settings.vars[0].value, KEY), "abc");
    const kept = ps.applySettingsUpdate({ vars: [{ name: "API_KEY" }] }, first.settings, { now: "2026-11-26T00:00:00Z", key: KEY });
    assert.equal(kept.ok, true);
    if (!kept.ok) return;
    assert.equal(kept.settings.vars.length, 1);
    assert.equal(kept.settings.vars[0].value, first.settings.vars[0].value);
    assert.equal(kept.settings.vars[0].updatedAt, "2026-11-25T00:00:00Z");
    assert.equal(kept.settings.size, undefined, "Standard is not stored");
    assert.equal(ps.applySettingsUpdate({ vars: [{ name: "NEW" }] }, first.settings, { key: KEY }).ok, false);
    assert.equal(ps.applySettingsUpdate({ vars: [{ name: "A", value: "1" }, { name: "a", value: "2" }] }, undefined, { key: KEY }).ok, false);
    assert.equal(ps.applySettingsUpdate({ vars: [{ name: "A", value: "1" }] }, undefined, { key: "" }).ok, false);
    assert.equal(ps.applySettingsUpdate({ size: "huge", vars: [] }, undefined, { key: KEY }).ok, false);
    assert.equal(ps.applySettingsUpdate({ vars: [{ name: "A", value: "x".repeat(8193) }] }, undefined, { key: KEY }).ok, false);
    const sizeOnly = ps.applySettingsUpdate({ size: "small", vars: [] }, undefined, { key: "" });
    assert.equal(sizeOnly.ok && sizeOnly.settings.size, "small", "a size saves without the key");
  });

  check("the page sees names and dates, never values; values a changed key can't read are flagged", () => {
    const stored = { vars: [{ name: "API_KEY", value: ps.encryptValue("topsecret", KEY), build: false, updatedAt: "2026-11-25T00:00:00Z" }], updatedAt: "2026-11-25T00:00:00Z" };
    const view = ps.settingsView("acme/web", stored, KEY);
    assert.ok(!JSON.stringify(view).includes("topsecret") && !JSON.stringify(view).includes("v1."));
    assert.equal(view.vars[0].readable, true);
    assert.equal(ps.settingsView("acme/web", stored, "z".repeat(40)).vars[0].readable, false);
    const env = ps.envFromSettings(stored, "z".repeat(40));
    assert.deepEqual(env, { runtime: {}, build: {}, unreadable: ["API_KEY"] });
  });

  check("runtime gets every value, the build only the ticked ones", () => {
    const settings = {
      vars: [
        { name: "SECRET", value: ps.encryptValue("s", KEY), build: false, updatedAt: "" },
        { name: "NEXT_PUBLIC_X", value: ps.encryptValue("p", KEY), build: true, updatedAt: "" },
      ],
      updatedAt: "",
    };
    assert.deepEqual(ps.envFromSettings(settings, KEY), { runtime: { SECRET: "s", NEXT_PUBLIC_X: "p" }, build: { NEXT_PUBLIC_X: "p" }, unreadable: [] });
    assert.deepEqual(buildArgs({ NEXT_PUBLIC_X: "p" }), ["--build-arg", "NEXT_PUBLIC_X"]);
  });

  check("damaged saved settings are dropped, not loaded", () => {
    const loaded = shape.asStoredSettings({
      "Acme/Web": { size: "large", vars: [{ name: "OK", value: "v1.a.b.c" }, { name: "bad name", value: "v1.a.b.c" }, { name: "PLAIN", value: "plaintext" }], updatedAt: "x" },
      "not a repo": { vars: [] },
    });
    assert.deepEqual(Object.keys(loaded ?? {}), ["acme/web"]);
    assert.deepEqual(loaded?.["acme/web"].vars.map((v) => v.name), ["OK"]);
    assert.equal(shape.asStoredSettings([]), undefined);
  });

  check(".env pasting: export, quotes, comments, \\n in double quotes, last one wins", () => {
    const parsed = parseDotEnv('# db\nexport DATABASE_URL="postgres://x"\nKEY=abc # note\nQ=\'a b\'\nML="line1\\nline2"\nbad line\nKEY=def\n');
    assert.deepEqual(parsed, [
      { name: "DATABASE_URL", value: "postgres://x" },
      { name: "Q", value: "a b" },
      { name: "ML", value: "line1\nline2" },
      { name: "KEY", value: "def" },
    ]);
  });

  check("build values printed by a Dockerfile are hidden in the log", () => {
    const text = hideValues("Step 3: echo https://api.example.test\nkey=abcd1234\nyes", { A: "https://api.example.test", B: "abcd1234", C: "yes" });
    assert.equal(text, "Step 3: echo [hidden]\nkey=[hidden]\nyes");
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
