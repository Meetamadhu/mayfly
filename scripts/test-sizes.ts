/**
 * New preview form logic: request checks, sizes (weights, prices, container limits) and size-weighted money.
 * Run with: npx tsx scripts/test-sizes.ts
 */
import assert from "node:assert/strict";
import type { UsageMonth } from "../src/lib/types";

async function main() {
  const { parseNewPreview } = await import("../src/lib/new-preview");
  const sizes = await import("../src/lib/sizes");
  const cost = await import("../src/lib/cost-view");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  check("a full request is read and tidied", () => {
    const r = parseNewPreview({ repository: " Acme/Web ", branch: " feat/x ", prNumber: "42", title: "  Add  pay ", size: "large", ttlHours: 24, budget: "5.005" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.request, { repository: "acme/web", branch: "feat/x", prNumber: 42, title: r.request.title, size: "large", ttlHours: 24, budget: 5.01 });
    assert.ok(r.request.title?.startsWith("Add"));
  });

  check("defaults: Standard, usual lifetime, no budget, PR found later", () => {
    const r = parseNewPreview({ repository: "acme/web", branch: "main" });
    assert.ok(r.ok && r.request.size === "standard" && r.request.ttlHours === null && r.request.budget === null && r.request.prNumber === null);
  });

  check("bad requests say what's wrong", () => {
    const bad: [unknown, RegExp][] = [
      [{ branch: "x" }, /repository/],
      [{ repository: "acme/web" }, /branch/],
      [{ repository: "acme/web", branch: "has space" }, /branch name/],
      [{ repository: "acme/web", branch: "-rf" }, /branch name/],
      [{ repository: "acme/web", branch: "x", prNumber: "4.2" }, /whole number/],
      [{ repository: "acme/web", branch: "x", size: "huge" }, /Small, Standard or Large/],
      [{ repository: "acme/web", branch: "x", ttlHours: 500 }, /7 days/],
      [{ repository: "acme/web", branch: "x", budget: -1 }, /budget/],
      [{ repository: "acme/web", branch: "x", budget: 5000 }, /budget/],
    ];
    for (const [input, pattern] of bad) {
      const r = parseNewPreview(input);
      assert.ok(!r.ok && pattern.test(r.error), JSON.stringify(input));
    }
  });

  check("sizes: weights, hourly prices and container limits", () => {
    assert.equal(sizes.sizeWeight(undefined), 1);
    assert.equal(sizes.sizeWeight("small"), 0.5);
    assert.equal(sizes.hourlyRate({ size: "large" }, 0.05), 0.1);
    assert.deepEqual(sizes.sizeLimits(undefined), {});
    assert.deepEqual(sizes.sizeLimits("standard"), {});
    assert.deepEqual(sizes.sizeLimits("small"), { PREVIEW_MEMORY: "256m", PREVIEW_CPUS: "0.25" });
    assert.deepEqual(sizes.sizeLimits("large"), { PREVIEW_MEMORY: "1g", PREVIEW_CPUS: "1" });
  });

  check("money uses size-weighted time, or plain time on older totals", () => {
    assert.deepEqual(sizes.moneySeconds({ awakeSeconds: 100, asleepSeconds: 50 }), { awake: 100, asleep: 50 });
    assert.deepEqual(sizes.moneySeconds({ awakeSeconds: 100, asleepSeconds: 50, awakeWeighted: 200, asleepWeighted: 25 }), { awake: 200, asleep: 25 });
    const now = Date.parse("2026-11-25T12:00:00Z");
    const usage: UsageMonth = {
      month: "2026-11", awakeSeconds: 3600, asleepSeconds: 3600, awakeWeighted: 7200, asleepWeighted: 1800, lastSampleAt: "2026-11-25T12:00:00Z",
      days: { "2026-11-25": { awakeSeconds: 3600, asleepSeconds: 3600, awakeWeighted: 7200, asleepWeighted: 1800 } },
    };
    const month = cost.periodSeconds(usage, "month", now);
    assert.equal(month.awake, 3600);
    assert.equal(month.awakeMoney, 7200);
    const bars = cost.spendBars(usage, "week", 0.05, now);
    assert.equal(bars[6].mayfly.toFixed(2), "0.10");
    assert.equal(bars[6].always.toFixed(3), "0.125");
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
