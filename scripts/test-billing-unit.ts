/**
 * Prepaid credit and Razorpay without a server: settings (test, live, missing), signatures, top-up limits,
 * charging awake time, orders being paid once only, saved billing, webhook payloads and the credit limit.
 * Run with: npx tsx scripts/test-billing-unit.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

async function main() {
  const b = await import("../src/lib/billing");
  const plans = await import("../src/lib/plans");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const SECRET = "unit-test-secret-not-real";

  check("settings: off without keys, test keys on, live keys refused unless allowed, bad ids explained", () => {
    assert.deepEqual(b.razorpaySettings({}), { enabled: false, problem: null, mode: null });
    const test = b.razorpaySettings({ RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: SECRET });
    assert.equal(test.enabled && test.mode, "test");
    assert.equal(test.enabled && test.apiUrl, "https://api.razorpay.com");
    const live = b.razorpaySettings({ RAZORPAY_KEY_ID: "rzp_live_abc123", RAZORPAY_KEY_SECRET: SECRET });
    assert.equal(live.enabled, false);
    assert.match(!live.enabled ? (live.problem ?? "") : "", /real money/);
    assert.equal(b.razorpaySettings({ RAZORPAY_KEY_ID: "rzp_live_abc123", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_ALLOW_LIVE: "true" }).enabled, true);
    const missing = b.razorpaySettings({ RAZORPAY_KEY_ID: "rzp_test_abc123" });
    assert.match(!missing.enabled ? (missing.problem ?? "") : "", /KEY_SECRET is missing/);
    const wrong = b.razorpaySettings({ RAZORPAY_KEY_ID: "abc", RAZORPAY_KEY_SECRET: SECRET });
    assert.match(!wrong.enabled ? (wrong.problem ?? "") : "", /should start with rzp_test_/);
  });

  check("Checkout signature: HMAC of order|payment with the key secret; anything else fails", () => {
    const good = createHmac("sha256", SECRET).update("order_ABC123456|pay_XYZ123456").digest("hex");
    assert.equal(b.verifyPaymentSignature("order_ABC123456", "pay_XYZ123456", good, SECRET), true);
    assert.equal(b.verifyPaymentSignature("order_OTHER12345", "pay_XYZ123456", good, SECRET), false);
    assert.equal(b.verifyPaymentSignature("order_ABC123456", "pay_XYZ123456", good, "another-secret"), false);
    assert.equal(b.verifyPaymentSignature("order_ABC123456", "pay_XYZ123456", "not-hex", SECRET), false);
    assert.equal(b.verifyPaymentSignature("order_ABC123456", "pay_XYZ123456", good.slice(2), SECRET), false);
  });

  check("webhook signature: HMAC of the raw body with the webhook secret", () => {
    const raw = Buffer.from('{"event":"order.paid"}');
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    assert.equal(b.verifyWebhookSignature(raw, sig, SECRET), true);
    assert.equal(b.verifyWebhookSignature(Buffer.from('{"event":"order.paid" }'), sig, SECRET), false);
    assert.equal(b.verifyWebhookSignature(raw, null, SECRET), false);
  });

  check("top-ups: whole rupees from ₹100 to ₹50,000", () => {
    assert.equal(b.topUpProblem(500), null);
    assert.match(b.topUpProblem(99) ?? "", /smallest top-up is ₹100/);
    assert.match(b.topUpProblem(50001) ?? "", /largest top-up is ₹50,000/);
    assert.match(b.topUpProblem(100.5) ?? "", /whole rupees/);
    assert.match(b.topUpProblem("500") ?? "", /whole rupees/);
  });

  check("awake time comes off the credit at ₹5 a Standard hour", () => {
    let billing = b.chargeAwake(undefined, 3600);
    assert.equal(billing.spent, 5);
    billing = b.chargeAwake({ ...billing, credited: 100 }, 7200);
    assert.equal(b.creditLeft(billing), 85);
    assert.equal(b.creditLeft(b.chargeAwake(billing, 0)), 85);
  });

  check("an order is paid once: a second report adds nothing; unknown orders are ignored", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    let billing = b.addOrder(undefined, { id: "order_ABC123456", amount: 500, status: "created", mode: "test", createdAt: new Date(now).toISOString() }, now);
    const first = b.markPaid(billing, "order_ABC123456", "pay_XYZ123456", now);
    assert.equal(first.credited, true);
    assert.equal(b.creditLeft(first.billing), 500);
    billing = first.billing;
    const again = b.markPaid(billing, "order_ABC123456", "pay_XYZ123456", now);
    assert.equal(again.credited, false);
    assert.equal(b.creditLeft(again.billing), 500);
    const stranger = b.markPaid(billing, "order_NOTOURS123", "pay_XYZ123456", now);
    assert.deepEqual([stranger.credited, stranger.known], [false, false]);
  });

  check("unpaid orders older than a day are dropped; paid ones are kept", () => {
    const old = "2026-11-20T00:00:00Z";
    let billing = b.addOrder(undefined, { id: "order_OLDUNPAID1", amount: 500, status: "created", mode: "test", createdAt: old });
    billing = b.addOrder(billing, { id: "order_OLDPAID123", amount: 500, status: "paid", mode: "test", createdAt: old });
    billing = b.addOrder(billing, { id: "order_NEW1234567", amount: 1000, status: "created", mode: "test", createdAt: "2026-11-26T00:00:00Z" }, Date.parse("2026-11-26T01:00:00Z"));
    assert.deepEqual(billing.orders.map((o) => o.id), ["order_NEW1234567", "order_OLDPAID123"]);
  });

  check("saved billing: damaged orders are dropped, damaged totals mean no billing", () => {
    const loaded = b.asBilling({
      credited: 500,
      spent: 12.5,
      orders: [
        { id: "order_GOOD123456", amount: 500, status: "paid", mode: "test", createdAt: "x", paymentId: "pay_GOOD123456" },
        { id: "nope", amount: 500, status: "paid", mode: "test", createdAt: "x" },
        { id: "order_BADSTATUS1", amount: 500, status: "refunded", mode: "test", createdAt: "x" },
      ],
    });
    assert.deepEqual(loaded?.orders.map((o) => o.id), ["order_GOOD123456"]);
    assert.equal(b.asBilling({ credited: -1, spent: 0, orders: [] }), undefined);
    assert.equal(b.asBilling("x"), undefined);
  });

  check("webhooks: order.paid and payment.captured give the order and payment; other events don't", () => {
    assert.deepEqual(
      b.paidFromWebhook({ event: "order.paid", payload: { order: { entity: { id: "order_A12345678" } }, payment: { entity: { id: "pay_B12345678", order_id: "order_A12345678" } } } }),
      { orderId: "order_A12345678", paymentId: "pay_B12345678" },
    );
    assert.deepEqual(b.paidFromWebhook({ event: "payment.captured", payload: { payment: { entity: { id: "pay_B12345678", order_id: "order_A12345678" } } } }), {
      orderId: "order_A12345678",
      paymentId: "pay_B12345678",
    });
    assert.equal(b.paidFromWebhook({ event: "payment.failed", payload: {} }), null);
    assert.equal(b.paidFromWebhook(null), null);
  });

  check("Pay as you go with payments set up: no credit, no new previews; without payments, no check", () => {
    const refused = plans.checkNewPreview(plans.PLANS.payg, [], { repository: "a/web", credit: -3.2 });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /credit has run out \(-₹3\.20 left\)/);
    assert.equal(plans.checkNewPreview(plans.PLANS.payg, [], { repository: "a/web", credit: 0.5 }).ok, true);
    assert.equal(plans.checkNewPreview(plans.PLANS.payg, [], { repository: "a/web", credit: null }).ok, true);
    assert.equal(plans.checkNewPreview(plans.PLANS.sandbox, [], { repository: "a/web", credit: 0 }).ok, true, "the Sandbox doesn't use credit");
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
