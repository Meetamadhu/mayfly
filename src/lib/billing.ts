import { createHmac, timingSafeEqual } from "node:crypto";
import { STANDARD_RATE } from "./plans";

/**
 * Prepaid credit for Pay as you go, paid through Razorpay.
 *
 * Admins add credit (₹500, ₹1,000, ₹2,000 or their own amount). Each awake second on Pay as you go is taken from it
 * at the size's hourly rate. When it runs out, new previews wait until credit is added; running ones carry on.
 *
 * Razorpay is optional. Without keys, Pay as you go stays demo pricing and credit isn't enforced. With test keys
 * (rzp_test_…) payments are simulated: test UPI and cards, no real money. Live keys (rzp_live_…) are refused unless
 * RAZORPAY_ALLOW_LIVE=true, so a key pasted in the wrong place can't start taking real money.
 *
 * Settings (in .env.local, never in the repository):
 *   RAZORPAY_KEY_ID          rzp_test_… (shown to the browser; that's what it's for)
 *   RAZORPAY_KEY_SECRET      server only, signs and checks payments
 *   RAZORPAY_WEBHOOK_SECRET  optional, for /api/webhooks/razorpay (credits a payment even if the tab was closed)
 *   RAZORPAY_ALLOW_LIVE      "true" to allow rzp_live_ keys
 */

export const TOP_UPS = [500, 1000, 2000];
export const MIN_TOP_UP = 100;
export const MAX_TOP_UP = 50000;
const KEPT_ORDERS = 100;

export type PaymentMode = "test" | "live";

export type BillingOrder = {
  /** Razorpay's order id. */
  id: string;
  /** Rupees. */
  amount: number;
  status: "created" | "paid";
  mode: PaymentMode;
  createdAt: string;
  paidAt?: string;
  paymentId?: string;
};

export type Billing = {
  /** Rupees added through paid orders. */
  credited: number;
  /** Rupees of awake time taken on Pay as you go. */
  spent: number;
  /** Newest first. */
  orders: BillingOrder[];
};

export function emptyBilling(): Billing {
  return { credited: 0, spent: 0, orders: [] };
}

export function creditLeft(billing: Billing | undefined) {
  return round2((billing?.credited ?? 0) - (billing?.spent ?? 0));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const money = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Saved billing if it's well formed; damaged orders are dropped, not loaded. */
export function asBilling(value: unknown): Billing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<Billing>;
  if (!money(raw.credited) || !money(raw.spent)) return undefined;
  const orders: BillingOrder[] = [];
  for (const order of Array.isArray(raw.orders) ? raw.orders : []) {
    if (!order || typeof order !== "object") continue;
    const o = order as Partial<BillingOrder>;
    if (typeof o.id !== "string" || !/^order_[A-Za-z0-9]{6,40}$/.test(o.id)) continue;
    if (!money(o.amount) || (o.status !== "created" && o.status !== "paid") || (o.mode !== "test" && o.mode !== "live")) continue;
    if (typeof o.createdAt !== "string") continue;
    orders.push({
      id: o.id,
      amount: o.amount,
      status: o.status,
      mode: o.mode,
      createdAt: o.createdAt,
      ...(typeof o.paidAt === "string" ? { paidAt: o.paidAt } : {}),
      ...(typeof o.paymentId === "string" && /^pay_[A-Za-z0-9]{6,40}$/.test(o.paymentId) ? { paymentId: o.paymentId } : {}),
    });
  }
  return { credited: raw.credited, spent: raw.spent, orders: orders.slice(0, KEPT_ORDERS) };
}

/** Take awake time from the credit: `weightedSeconds` are awake seconds weighted by size (Standard = 1). */
export function chargeAwake(billing: Billing | undefined, weightedSeconds: number): Billing {
  const next = billing ? { ...billing } : emptyBilling();
  if (weightedSeconds > 0) next.spent = next.spent + (weightedSeconds / 3600) * STANDARD_RATE;
  return next;
}

/** A whole-rupee amount within the limits, or the reason it isn't. */
export function topUpProblem(amount: unknown): string | null {
  if (typeof amount !== "number" || !Number.isInteger(amount)) return "Enter the amount in whole rupees.";
  if (amount < MIN_TOP_UP) return `The smallest top-up is ₹${MIN_TOP_UP}.`;
  if (amount > MAX_TOP_UP) return `The largest top-up is ₹${MAX_TOP_UP.toLocaleString("en-IN")}.`;
  return null;
}

/** Remember a new order (unpaid ones older than a day are dropped). */
export function addOrder(billing: Billing | undefined, order: BillingOrder, now = Date.now()): Billing {
  const next = billing ? { ...billing } : emptyBilling();
  const day = 24 * 60 * 60 * 1000;
  const kept = next.orders.filter((o) => o.id !== order.id && (o.status === "paid" || now - Date.parse(o.createdAt) < day));
  next.orders = [order, ...kept].slice(0, KEPT_ORDERS);
  return next;
}

/**
 * Mark one of our orders paid and add its amount to the credit. Safe to call twice (the browser and the webhook
 * both report the same payment): the second call changes nothing. Orders Mayfly didn't create are ignored.
 */
export function markPaid(billing: Billing | undefined, orderId: string, paymentId: string, now = Date.now()) {
  const current = billing ?? emptyBilling();
  const order = current.orders.find((o) => o.id === orderId);
  if (!order) return { billing: current, credited: false, known: false };
  if (order.status === "paid") return { billing: current, credited: false, known: true };
  const paid: BillingOrder = { ...order, status: "paid", paidAt: new Date(now).toISOString(), paymentId };
  return {
    billing: { ...current, credited: current.credited + order.amount, orders: current.orders.map((o) => (o.id === orderId ? paid : o)) },
    credited: true,
    known: true,
  };
}

// ---- Razorpay ----

export type RazorpaySettings =
  | { enabled: true; keyId: string; keySecret: string; webhookSecret: string | null; mode: PaymentMode; apiUrl: string }
  | { enabled: false; problem: string | null; mode: PaymentMode | null };

export function razorpaySettings(env: Record<string, string | undefined> = process.env): RazorpaySettings {
  const keyId = (env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET ?? "").trim();
  const webhookSecret = (env.RAZORPAY_WEBHOOK_SECRET ?? "").trim() || null;
  if (!keyId && !keySecret) return { enabled: false, problem: null, mode: null };
  const mode: PaymentMode | null = keyId.startsWith("rzp_test_") ? "test" : keyId.startsWith("rzp_live_") ? "live" : null;
  if (!mode) return { enabled: false, problem: "RAZORPAY_KEY_ID should start with rzp_test_ (or rzp_live_).", mode: null };
  if (!keySecret) return { enabled: false, problem: "RAZORPAY_KEY_SECRET is missing.", mode };
  if (mode === "live" && env.RAZORPAY_ALLOW_LIVE !== "true") {
    return { enabled: false, problem: "These are live Razorpay keys, which take real money. Set RAZORPAY_ALLOW_LIVE=true to allow them.", mode };
  }
  const apiUrl = (env.RAZORPAY_API_URL ?? "https://api.razorpay.com").replace(/\/+$/, "");
  return { enabled: true, keyId, keySecret, webhookSecret, mode, apiUrl };
}

function hmacHex(secret: string, message: string | Buffer) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function sameHex(a: string, b: string) {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Checkout's signature: HMAC-SHA256 of "<our order id>|<payment id>" with the key secret. */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string, keySecret: string) {
  return sameHex(signature, hmacHex(keySecret, `${orderId}|${paymentId}`));
}

/** Webhook signature: HMAC-SHA256 of the raw body with the webhook secret, in X-Razorpay-Signature. */
export function verifyWebhookSignature(raw: Buffer, signature: string | null, webhookSecret: string) {
  return Boolean(signature) && sameHex(signature!, hmacHex(webhookSecret, raw));
}

/** Create an order for `amount` rupees. Razorpay counts in paise. */
export async function createRazorpayOrder(settings: Extract<RazorpaySettings, { enabled: true }>, amount: number) {
  const res = await fetch(`${settings.apiUrl}/v1/orders`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.keyId}:${settings.keySecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount: amount * 100,
      currency: "INR",
      receipt: `mayfly-${Date.now()}`,
      notes: { purpose: "Mayfly prepaid credit" },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; amount?: number; error?: { description?: string } };
  if (!res.ok || typeof body.id !== "string" || !/^order_[A-Za-z0-9]{6,40}$/.test(body.id)) {
    const reason = body.error?.description ?? `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? "Razorpay didn't accept the keys. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." : `Razorpay couldn't create the payment: ${reason}`);
  }
  return { id: body.id };
}

/** The order and payment ids in an order.paid or payment.captured webhook, if it is one. */
export function paidFromWebhook(payload: unknown): { orderId: string; paymentId: string } | null {
  const p = payload as {
    event?: string;
    payload?: { order?: { entity?: { id?: string } }; payment?: { entity?: { id?: string; order_id?: string } } };
  };
  if (p?.event !== "order.paid" && p?.event !== "payment.captured") return null;
  const orderId = p.payload?.order?.entity?.id ?? p.payload?.payment?.entity?.order_id;
  const paymentId = p.payload?.payment?.entity?.id;
  if (typeof orderId !== "string" || typeof paymentId !== "string") return null;
  return { orderId, paymentId };
}
