/**
 * Plans and usage billing without a server: rates, the month's bill, the Sandbox's free hours, limits on previews,
 * repositories and sizes, saved plans (including ones saved before usage billing) and the calculator.
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
  const MID_NOV = Date.parse("2026-11-16T00:00:00Z");

  check("rupees: paise below ₹100, whole rupees with Indian grouping above", () => {
    assert.equal(plans.formatRupees(0), "₹0");
    assert.equal(plans.formatRupees(2.5), "₹2.50");
    assert.equal(plans.formatRupees(5), "₹5");
    assert.equal(plans.formatRupees(12.4), "₹12.40");
    assert.equal(plans.formatRupees(3650), "₹3,650");
    assert.equal(plans.formatRupees(100000), "₹1,00,000");
    assert.equal(plans.rateLabel("large"), "₹10/hr");
  });

  check("an install with no plan is on Pay as you go, so older installs get no new limits", () => {
    assert.equal(plans.currentPlan(undefined).id, "payg");
  });

  check("saved plans: bad ones are dropped, old Free/Team/Business are mapped, all marked demo", () => {
    const since = "2026-11-26T00:00:00Z";
    assert.equal(plans.asStoredPlan(null), undefined);
    assert.equal(plans.asStoredPlan({ id: "gold", since }), undefined);
    assert.equal(plans.asStoredPlan({ id: "sandbox", since: "not a date" }), undefined);
    assert.deepEqual(plans.asStoredPlan({ id: "free", since }), { id: "sandbox", since, demo: true });
    assert.deepEqual(plans.asStoredPlan({ id: "team", since }), { id: "payg", since, demo: true });
    assert.deepEqual(plans.asStoredPlan({ id: "business", since }), { id: "payg", since, demo: true });
    assert.deepEqual(plans.asStoredPlan({ id: "enterprise", since, demo: false, extra: 1 }), { id: "enterprise", since, demo: true });
  });

  check("this month's hours come from the size-weighted totals; last month's don't count", () => {
    const usage = { month: "2026-11", awakeSeconds: 7200, asleepSeconds: 0, awakeWeighted: 10800, lastSampleAt: "" };
    assert.deepEqual(plans.monthHours(usage, MID_NOV), { standardHours: 3, awakeHours: 2 });
    assert.deepEqual(plans.monthHours({ ...usage, month: "2026-10" }, MID_NOV), { standardHours: 0, awakeHours: 0 });
    assert.deepEqual(plans.monthHours({ month: "2026-11", awakeSeconds: 3600, asleepSeconds: 0, lastSampleAt: "" }, MID_NOV), { standardHours: 1, awakeHours: 1 });
  });

  check("the bill: Pay as you go charges ₹5 a Standard hour and projects the month; Sandbox counts free hours", () => {
    const bill = plans.monthBill(PLANS.payg, { standardHours: 20 }, MID_NOV);
    assert.equal(bill.amount, 100);
    assert.ok(bill.projected! > 180 && bill.projected! < 210, String(bill.projected));
    assert.deepEqual(plans.monthBill(PLANS.sandbox, { standardHours: 12 }, MID_NOV), { amount: 0, projected: 0, freeHoursLeft: 18 });
    assert.deepEqual(plans.monthBill(PLANS.sandbox, { standardHours: 45 }, MID_NOV).freeHoursLeft, 0);
    assert.deepEqual(plans.monthBill(PLANS.enterprise, { standardHours: 45 }, MID_NOV), { amount: null, projected: null, freeHoursLeft: null });
  });

  check("Sandbox: 2 previews at a time; removed, removing and the demo don't count", () => {
    const envs = [env("a/web", 1), env("a/web", 3, "destroyed"), env("a/web", 4, "destroying"), env("demo/app", 1)];
    const isDemo = (e: { repository: string }) => e.repository === "demo/app";
    assert.deepEqual(plans.planUsage(envs, undefined, isDemo), { previews: 1, repositories: 1, standardHours: 0, awakeHours: 0 });
    assert.deepEqual(plans.checkNewPreview(PLANS.sandbox, envs, { repository: "a/web" }, isDemo), { ok: true, size: "standard" });
    const full = plans.checkNewPreview(PLANS.sandbox, [...envs, env("a/web", 5, "updating")], { repository: "a/web" }, isDemo);
    assert.equal(full.ok, false);
    assert.match(full.ok ? "" : full.error, /Sandbox runs 2 previews at a time, and 2 are running/);
  });

  check("Sandbox: once the month's 30 hours are used, new previews wait for next month", () => {
    assert.equal(plans.checkNewPreview(PLANS.sandbox, [], { repository: "a/web", standardHours: 29.9 }).ok, true);
    const used = plans.checkNewPreview(PLANS.sandbox, [], { repository: "a/web", standardHours: 30, now: MID_NOV });
    assert.equal(used.ok, false);
    assert.match(used.ok ? "" : used.error, /includes 30 awake hours a month, and this month's are used up\. New previews can start again on 1 Dec/);
    assert.equal(plans.checkNewPreview(PLANS.payg, [], { repository: "a/web", standardHours: 5000 }).ok, true);
  });

  check("repositories and sizes on the Sandbox; Pay as you go and Enterprise have no limits", () => {
    const envs = [env("a/web", 1)];
    const other = plans.checkNewPreview(PLANS.sandbox, envs, { repository: "a/api" });
    assert.match(other.ok ? "" : other.error, /covers 1 repository at a time, and previews are running for a\/web/);
    const large = plans.checkNewPreview(PLANS.sandbox, [], { repository: "a/web", size: "large" });
    assert.match(large.ok ? "" : large.error, /Large previews aren't part of the Sandbox\. Pick Small or Standard/);
    assert.deepEqual(plans.checkNewPreview(PLANS.sandbox, [], { repository: "a/web", defaultSize: "large" }), { ok: true, size: "standard" });
    const many = Array.from({ length: 40 }, (_, i) => env(`o/r${i}`, i + 1));
    for (const id of ["payg", "enterprise"] as const) {
      assert.deepEqual(plans.checkNewPreview(PLANS[id], many, { repository: "o/new", size: "large" }), { ok: true, size: "large" });
    }
  });

  check("card lines say what each plan includes", () => {
    assert.deepEqual(plans.planLines(PLANS.sandbox).slice(0, 4), ["30 awake hours a month included", "2 previews at a time", "1 repository", "Small or Standard sizes"]);
    assert.deepEqual(plans.planLines(PLANS.payg).slice(0, 2), ["Unlimited previews and repositories", "Small ₹2.50/hr, Standard ₹5/hr, Large ₹10/hr"]);
    assert.equal(plans.planLines(PLANS.enterprise)[1], "Everything in Pay as you go");
  });

  check("moving to the Sandbox names what's over its limits", () => {
    assert.deepEqual(plans.overLimits(PLANS.sandbox, { previews: 1, repositories: 1, standardHours: 3, awakeHours: 3 }), []);
    const over = plans.overLimits(PLANS.sandbox, { previews: 5, repositories: 2, standardHours: 40, awakeHours: 40 });
    assert.equal(over.length, 3);
    assert.match(over[0], /5 previews are running and the Sandbox allows 2/);
    assert.match(over[2], /40 awake hours are past the 30/);
  });

  check("calculator: billed for awake hours only, compared with never sleeping", () => {
    const est = plans.estimateBill({ pullRequests: 40, size: "standard", hoursAwake: 3, daysOpen: 4 });
    assert.equal(est.awakeHours, 120);
    assert.equal(est.mayfly, 600);
    assert.equal(est.alwaysOn, 40 * 96 * 5);
    assert.equal(est.saving, est.alwaysOn - 600);
    assert.equal(est.fitsSandbox, false);
    const small = plans.estimateBill({ pullRequests: 10, size: "small", hoursAwake: 4, daysOpen: 2 });
    assert.equal(small.mayfly, 100);
    assert.equal(small.standardHours, 20);
    assert.equal(small.fitsSandbox, true);
    assert.equal(plans.estimateBill({ pullRequests: 1, size: "large", hoursAwake: 1, daysOpen: 1 }).fitsSandbox, false);
    assert.equal(plans.estimateBill({ pullRequests: 1, size: "standard", hoursAwake: 100, daysOpen: 1 }).awakeHours, 24, "awake can't exceed open time");
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
