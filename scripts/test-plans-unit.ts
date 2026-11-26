/**
 * Plan logic without a server: limits on previews, repositories and sizes, prices, and saved plans.
 * Run with: npx tsx scripts/test-plans-unit.ts
 */
import assert from "node:assert/strict";

async function main() {
  const plans = await import("../src/lib/plans");
  const { PLANS } = plans;
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const env = (repository: string, prNumber: number, status = "ready") =>
    ({ id: `${repository}#${prNumber}`, repository, prNumber, status }) as never;

  check("prices: rupees with Indian grouping", () => {
    assert.equal(plans.formatPrice(0), "₹0");
    assert.equal(plans.formatPrice(999), "₹999");
    assert.equal(plans.formatPrice(2999), "₹2,999");
    assert.equal(plans.formatPrice(100000), "₹1,00,000");
  });

  check("an install with no plan is on Team, so older installs keep working", () => {
    assert.equal(plans.currentPlan(undefined).id, "team");
    assert.equal(plans.currentPlan({ id: "free", since: "2026-11-26T00:00:00Z", demo: true }).id, "free");
  });

  check("saved plans: bad ones are dropped, good ones always marked demo", () => {
    assert.equal(plans.asStoredPlan(null), undefined);
    assert.equal(plans.asStoredPlan({ id: "gold", since: "2026-11-26T00:00:00Z" }), undefined);
    assert.equal(plans.asStoredPlan({ id: "free", since: "not a date" }), undefined);
    assert.deepEqual(plans.asStoredPlan({ id: "business", since: "2026-11-26T00:00:00Z", demo: false, extra: 1 }), {
      id: "business",
      since: "2026-11-26T00:00:00Z",
      demo: true,
    });
  });

  check("previews at a time: live ones count, removed, removing and the demo don't", () => {
    const envs = [env("a/web", 1), env("a/web", 2, "updating"), env("a/web", 3, "destroyed"), env("a/web", 4, "destroying"), env("demo/app", 1)];
    const isDemo = (e: { repository: string }) => e.repository === "demo/app";
    assert.deepEqual(plans.planUsage(envs, isDemo), { previews: 2, repositories: 1 });
    const ok = plans.checkNewPreview(PLANS.free, envs, { repository: "a/web" }, isDemo);
    assert.deepEqual(ok, { ok: true, size: "standard" });
    const full = plans.checkNewPreview(PLANS.free, [...envs, env("a/web", 5, "provisioning")], { repository: "a/web" }, isDemo);
    assert.equal(full.ok, false);
    assert.match(full.ok ? "" : full.error, /Free plan runs 3 previews at a time, and 3 are running/);
  });

  check("repositories: a new one is refused when the plan's are taken, the same one isn't", () => {
    const envs = [env("a/web", 1)];
    assert.equal(plans.checkNewPreview(PLANS.free, envs, { repository: "a/web" }).ok, true);
    const other = plans.checkNewPreview(PLANS.free, envs, { repository: "a/api" });
    assert.equal(other.ok, false);
    assert.match(other.ok ? "" : other.error, /covers 1 repository at a time, and previews are running for a\/web/);
    assert.equal(plans.checkNewPreview(PLANS.team, envs, { repository: "a/api" }).ok, true);
  });

  check("sizes: one picked by hand is refused, a repository's saved one falls back to Standard", () => {
    const picked = plans.checkNewPreview(PLANS.free, [], { repository: "a/web", size: "large" });
    assert.equal(picked.ok, false);
    assert.match(picked.ok ? "" : picked.error, /Large previews aren't part of the Free plan\. Pick Small or Standard/);
    assert.deepEqual(plans.checkNewPreview(PLANS.free, [], { repository: "a/web", defaultSize: "large" }), { ok: true, size: "standard" });
    assert.deepEqual(plans.checkNewPreview(PLANS.free, [], { repository: "a/web", defaultSize: "small" }), { ok: true, size: "small" });
    assert.deepEqual(plans.checkNewPreview(PLANS.team, [], { repository: "a/web", size: "large" }), { ok: true, size: "large" });
  });

  check("Business has no limits", () => {
    const many = Array.from({ length: 40 }, (_, i) => env(`o/r${i}`, i + 1));
    assert.deepEqual(plans.checkNewPreview(PLANS.business, many, { repository: "o/new", size: "large" }), { ok: true, size: "large" });
    assert.deepEqual(plans.planLines(PLANS.business), ["Unlimited previews at a time", "Unlimited repositories", "All sizes, including Large"]);
    assert.deepEqual(plans.planLines(PLANS.free), ["3 previews at a time", "1 repository", "Small or Standard sizes"]);
  });

  check("moving to a smaller plan names what's over its limits", () => {
    assert.deepEqual(plans.overLimits(PLANS.free, { previews: 2, repositories: 1 }), []);
    const over = plans.overLimits(PLANS.free, { previews: 5, repositories: 2 });
    assert.equal(over.length, 2);
    assert.match(over[0], /5 previews are running and Free allows 3/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
