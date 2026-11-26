import express, { Router } from "express";
import {
  MAX_TOP_UP,
  MIN_TOP_UP,
  TOP_UPS,
  addOrder,
  createRazorpayOrder,
  creditLeft,
  markPaid,
  paidFromWebhook,
  razorpaySettings,
  topUpProblem,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "@/lib/billing";
import { currentPlan } from "@/lib/plans";
import { exclusive, loadState, saveState, type State } from "@/lib/store";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

/**
 * Prepaid credit through Razorpay (admins only, except the webhook, which Razorpay signs).
 *   GET  /api/billing                credit left, whether payments are set up, recent payments
 *   POST /api/billing/orders         { amount } in rupees: starts a payment, returns what Checkout needs
 *   POST /api/billing/verify         Checkout's { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *   POST /api/webhooks/razorpay      order.paid / payment.captured, signed with RAZORPAY_WEBHOOK_SECRET
 * The key secret and webhook secret never leave the server. Amounts always come from Mayfly's own order record.
 */
export const billingRouter = Router();

const json = express.json({ limit: "4kb" });
const withJson: express.RequestHandler = (req, res, next) =>
  json(req, res, (err?: unknown) => {
    if (err) {
      sendJson(res, { ok: false, code: "invalid", error: "Send JSON." }, 400);
      return;
    }
    next();
  });

function view(state: State) {
  const settings = razorpaySettings();
  const billing = state.billing;
  return {
    ok: true,
    payments: settings.enabled
      ? { enabled: true, mode: settings.mode, keyId: settings.keyId, webhook: Boolean(settings.webhookSecret) }
      : { enabled: false, mode: settings.mode, problem: settings.problem },
    plan: currentPlan(state.plan).id,
    credit: creditLeft(billing),
    credited: Math.round((billing?.credited ?? 0) * 100) / 100,
    spent: Math.round((billing?.spent ?? 0) * 100) / 100,
    topUps: TOP_UPS,
    min: MIN_TOP_UP,
    max: MAX_TOP_UP,
    orders: (billing?.orders ?? []).filter((o) => o.status === "paid").slice(0, 20),
  };
}

billingRouter.get(
  "/api/billing",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, view(await loadState()));
  }),
);

billingRouter.post(
  "/api/billing/orders",
  requireAdmin,
  withJson,
  asyncHandler(async (req, res) => {
    const settings = razorpaySettings();
    if (!settings.enabled) {
      sendJson(res, { ok: false, code: "not_configured", error: settings.problem ?? "Payments aren't set up. Add Razorpay test keys to .env.local first." }, 503);
      return;
    }
    const amount = (req.body as { amount?: unknown } | undefined)?.amount;
    const problem = topUpProblem(amount);
    if (problem) {
      sendJson(res, { ok: false, code: "invalid", error: problem }, 400);
      return;
    }
    let order: { id: string };
    try {
      order = await createRazorpayOrder(settings, amount as number);
    } catch (error) {
      sendJson(res, { ok: false, code: "payment_provider", error: error instanceof Error ? error.message : "Razorpay couldn't be reached." }, 502);
      return;
    }
    await exclusive(async () => {
      const state = await loadState();
      state.billing = addOrder(state.billing, { id: order.id, amount: amount as number, status: "created", mode: settings.mode, createdAt: new Date().toISOString() });
      await saveState(state);
    });
    sendJson(res, {
      ok: true,
      checkout: { key: settings.keyId, orderId: order.id, amount: (amount as number) * 100, currency: "INR", name: "Mayfly", description: `₹${(amount as number).toLocaleString("en-IN")} prepaid credit` },
      mode: settings.mode,
    });
  }),
);

billingRouter.post(
  "/api/billing/verify",
  requireAdmin,
  withJson,
  asyncHandler(async (req, res) => {
    const settings = razorpaySettings();
    if (!settings.enabled) {
      sendJson(res, { ok: false, code: "not_configured", error: "Payments aren't set up." }, 503);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderId = body.razorpay_order_id;
    const paymentId = body.razorpay_payment_id;
    const signature = body.razorpay_signature;
    if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string" || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
      sendJson(res, { ok: false, code: "invalid", error: "That payment response is incomplete." }, 400);
      return;
    }
    const result = await exclusive(async () => {
      const state = await loadState();
      // Check against Mayfly's own record of the order, never an id or amount the browser made up.
      const order = state.billing?.orders.find((o) => o.id === orderId);
      if (!order) return { status: 404, body: { ok: false, code: "not_found", error: "Mayfly didn't start that payment." } };
      if (!verifyPaymentSignature(order.id, paymentId, signature, settings.keySecret)) {
        return { status: 400, body: { ok: false, code: "bad_signature", error: "The payment couldn't be confirmed, so no credit was added." } };
      }
      const paid = markPaid(state.billing, order.id, paymentId);
      if (paid.credited) {
        state.billing = paid.billing;
        await saveState(state);
      }
      return { status: 200, body: { ...view(state), added: paid.credited ? order.amount : 0 } };
    });
    sendJson(res, result.body, result.status);
  }),
);

billingRouter.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "*/*", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const settings = razorpaySettings();
    if (!settings.enabled || !settings.webhookSecret) {
      sendJson(res, { ok: false, error: "Razorpay webhooks aren't set up (RAZORPAY_WEBHOOK_SECRET)." }, 503);
      return;
    }
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const header = typeof req.headers["x-razorpay-signature"] === "string" ? req.headers["x-razorpay-signature"] : null;
    if (!verifyWebhookSignature(raw, header, settings.webhookSecret)) {
      sendJson(res, { ok: false, error: "Invalid webhook signature." }, 401);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, { ok: false, error: "Webhook body was not JSON." }, 400);
      return;
    }
    const paid = paidFromWebhook(payload);
    if (!paid) {
      sendJson(res, { ok: true, ignored: true });
      return;
    }
    const outcome = await exclusive(async () => {
      const state = await loadState();
      const result = markPaid(state.billing, paid.orderId, paid.paymentId);
      if (result.credited) {
        state.billing = result.billing;
        await saveState(state);
      }
      return result;
    });
    // 200 even for orders Mayfly doesn't know, so Razorpay doesn't keep retrying them.
    sendJson(res, { ok: true, credited: outcome.credited, known: outcome.known });
  }),
);
