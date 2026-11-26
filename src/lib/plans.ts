import { isLiveStatus, type Environment, type UsageMonth } from "./types";
import { PREVIEW_SIZES, SIZE_INFO, type PreviewSize } from "./sizes";

/**
 * Plans and usage billing (demo pricing, in rupees). Modelled on usage-based hosting: you pay for what runs, and
 * for Mayfly that's the time a preview is awake. Asleep previews cost nothing.
 *
 *   Sandbox        free: a monthly allowance of awake hours, with small limits
 *   Pay as you go  a price per awake hour by size, billed by the second, no limits and no seat fees
 *   Enterprise     custom rates and terms
 *
 * Changing plan is a demo checkout that switches straight away; no payment is ever taken. Limits are checked when a
 * new preview would start; previews already running are never stopped by a plan change.
 */

export type PlanId = "sandbox" | "payg" | "enterprise";

export const PLAN_IDS: PlanId[] = ["sandbox", "payg", "enterprise"];

/** Rupees per awake hour, by size. Billed by the second. Asleep time is free. */
export const HOURLY_RATES: Record<PreviewSize, number> = { small: 2.5, standard: 5, large: 10 };

/** The Standard rate; other sizes cost in proportion (Small half, Large double). */
export const STANDARD_RATE = HOURLY_RATES.standard;

export type Plan = {
  id: PlanId;
  name: string;
  /** The big price on the card: "₹0", "₹5", "Custom". */
  price: string;
  /** What the price is per: "a month", "per awake hour", ... */
  per: string;
  blurb: string;
  /** null: no limit. */
  maxPreviews: number | null;
  maxRepositories: number | null;
  sizes: PreviewSize[];
  /** Awake hours included each month, counted at Standard size (a Small hour is half, a Large hour two). null: billed instead. */
  freeHours: number | null;
  /** Whether awake time is billed at HOURLY_RATES. */
  billed: boolean;
  /** What else the plan includes, as short lines. */
  extras: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  sandbox: {
    id: "sandbox",
    name: "Sandbox",
    price: "₹0",
    per: "a month",
    blurb: "Try Mayfly on one project. No card needed.",
    maxPreviews: 2,
    maxRepositories: 1,
    sizes: ["small", "standard"],
    freeHours: 30,
    billed: false,
    extras: ["Previews sleep when idle and wake on the next visit"],
  },
  payg: {
    id: "payg",
    name: "Pay as you go",
    price: `₹${STANDARD_RATE}`,
    per: "per awake hour",
    blurb: "Pay only while someone is looking. Billed by the second.",
    maxPreviews: null,
    maxRepositories: null,
    sizes: ["small", "standard", "large"],
    freeHours: null,
    billed: true,
    extras: ["Asleep previews are free", "No seat fees: invite the whole team"],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    per: "rates and terms",
    blurb: "For many teams, with volume rates and help running it.",
    maxPreviews: null,
    maxRepositories: null,
    sizes: ["small", "standard", "large"],
    freeHours: null,
    billed: false,
    extras: ["Everything in Pay as you go", "Lower hourly rates at volume", "Runs on your own servers", "Help with setup and support"],
  },
};

/** The plan before anyone picks one: Pay as you go, so installs from before plans existed have no new limits. */
export const DEFAULT_PLAN: PlanId = "payg";

/** The saved plan. `demo` is always true: no payment was taken to get it. */
export type StoredPlan = { id: PlanId; since: string; demo: true };

export function isPlanId(value: unknown): value is PlanId {
  return value === "sandbox" || value === "payg" || value === "enterprise";
}

/** Plans saved before usage billing: Free became the Sandbox, Team and Business became Pay as you go. */
const RENAMED: Record<string, PlanId> = { free: "sandbox", team: "payg", business: "payg" };

/** A saved plan if it's well formed, otherwise nothing (and the default applies). */
export function asStoredPlan(value: unknown): StoredPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { id?: unknown; since?: unknown };
  const id = isPlanId(raw.id) ? raw.id : typeof raw.id === "string" ? RENAMED[raw.id] : undefined;
  if (!id || typeof raw.since !== "string" || Number.isNaN(Date.parse(raw.since))) return undefined;
  return { id, since: raw.since, demo: true };
}

export function currentPlan(stored: StoredPlan | undefined): Plan {
  return PLANS[stored?.id ?? DEFAULT_PLAN];
}

/** ₹12.40 below ₹100, ₹1,234 from there, with Indian digit grouping (₹1,00,000). */
export function formatRupees(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return "₹0";
  if (amount < 100) return `₹${amount.toFixed(2).replace(/\.00$/, "")}`;
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

/** "₹2.50/hr" for a size's rate. */
export function rateLabel(size: PreviewSize) {
  return `${formatRupees(HOURLY_RATES[size])}/hr`;
}

// ---- what's running ----

/** Previews that count towards a plan: live ones, not being removed, not the built-in demo. */
export function countedPreviews(environments: Environment[], isDemo: (env: Environment) => boolean = () => false) {
  return environments.filter((env) => isLiveStatus(env.status) && env.status !== "destroying" && !isDemo(env));
}

export type PlanUsage = {
  previews: number;
  repositories: number;
  /** Awake hours this calendar month (UTC), counted at Standard size. */
  standardHours: number;
  /** Awake hours this month as they happened, whatever the size. */
  awakeHours: number;
};

/** This month's awake hours from the usage totals, or none when the totals are from an earlier month. */
export function monthHours(usage: UsageMonth | undefined, now = Date.now()) {
  if (!usage || usage.month !== new Date(now).toISOString().slice(0, 7)) return { standardHours: 0, awakeHours: 0 };
  return {
    standardHours: (usage.awakeWeighted ?? usage.awakeSeconds ?? 0) / 3600,
    awakeHours: (usage.awakeSeconds ?? 0) / 3600,
  };
}

export function planUsage(environments: Environment[], usage?: UsageMonth, isDemo?: (env: Environment) => boolean, now = Date.now()): PlanUsage {
  const counted = countedPreviews(environments, isDemo);
  return { previews: counted.length, repositories: new Set(counted.map((env) => env.repository)).size, ...monthHours(usage, now) };
}

// ---- billing ----

export type MonthBill = {
  /** Charged so far this month; null on custom rates. */
  amount: number | null;
  /** The same rate kept up for the rest of the month. */
  projected: number | null;
  /** Sandbox: included hours left this month. */
  freeHoursLeft: number | null;
};

/** How far through the calendar month (UTC) `now` is, 0 to 1. */
export function monthProgress(now = Date.now()) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function monthBill(plan: Plan, usage: Pick<PlanUsage, "standardHours">, now = Date.now()): MonthBill {
  const progress = Math.max(monthProgress(now), 1 / 31);
  if (plan.billed) {
    const amount = usage.standardHours * STANDARD_RATE;
    return { amount, projected: amount / progress, freeHoursLeft: null };
  }
  if (plan.freeHours !== null) return { amount: 0, projected: 0, freeHoursLeft: Math.max(0, plan.freeHours - usage.standardHours) };
  return { amount: null, projected: null, freeHoursLeft: null };
}

/** The first day of next month, for "starts again on 1 Dec". */
export function nextMonthStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

// ---- limits ----

export type PlanCheck = { ok: true; size: PreviewSize } | { ok: false; error: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether a new preview may start on this plan, and the size it gets.
 * - `size`: chosen by hand. A size the plan doesn't include is refused.
 * - `defaultSize`: from the repository's preview settings. A size the plan doesn't include falls back to Standard,
 *   so a plan change never stops a repository's previews from building.
 * - `standardHours`: awake hours used this month, for the Sandbox's allowance.
 * - `credit`: prepaid credit left on Pay as you go, when payments are set up.
 */
export function checkNewPreview(
  plan: Plan,
  environments: Environment[],
  request: {
    repository: string;
    size?: PreviewSize | null;
    defaultSize?: PreviewSize | null;
    standardHours?: number;
    /** Prepaid credit left, in rupees, when payments are set up; null when they aren't (credit isn't enforced). */
    credit?: number | null;
    now?: number;
  },
  isDemo?: (env: Environment) => boolean,
): PlanCheck {
  if (plan.billed && typeof request.credit === "number" && request.credit <= 0) {
    return {
      ok: false,
      error: `Pay as you go credit has run out (${request.credit < 0 ? "-" : ""}${formatRupees(Math.abs(request.credit))} left). An admin can add credit on the Pricing page; running previews carry on meanwhile.`,
    };
  }
  if (plan.freeHours !== null && (request.standardHours ?? 0) >= plan.freeHours) {
    const restart = nextMonthStart(request.now).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return {
      ok: false,
      error: `The ${plan.name} includes ${plan.freeHours} awake hours a month, and this month's are used up. New previews can start again on ${restart}, or move to Pay as you go.`,
    };
  }
  const counted = countedPreviews(environments, isDemo);
  if (plan.maxPreviews !== null && counted.length >= plan.maxPreviews) {
    return {
      ok: false,
      error: `The ${plan.name} runs ${plural(plan.maxPreviews, "preview", "previews")} at a time, and ${counted.length} ${counted.length === 1 ? "is" : "are"} running. Close a pull request, or move to Pay as you go.`,
    };
  }
  const repositories = new Set(counted.map((env) => env.repository));
  if (plan.maxRepositories !== null && !repositories.has(request.repository) && repositories.size >= plan.maxRepositories) {
    return {
      ok: false,
      error: `The ${plan.name} covers ${plural(plan.maxRepositories, "repository", "repositories")} at a time, and previews are running for ${[...repositories].sort().join(", ")}. Close those pull requests, or move to Pay as you go.`,
    };
  }
  if (request.size && !plan.sizes.includes(request.size)) {
    return {
      ok: false,
      error: `${SIZE_INFO[request.size].label} previews aren't part of the ${plan.name}. Pick ${sizeList(plan.sizes)}, or move to Pay as you go.`,
    };
  }
  const fallback = request.defaultSize && plan.sizes.includes(request.defaultSize) ? request.defaultSize : "standard";
  return { ok: true, size: request.size ?? fallback };
}

function sizeList(sizes: PreviewSize[]) {
  const names = PREVIEW_SIZES.filter((size) => sizes.includes(size)).map((size) => SIZE_INFO[size].label);
  return names.length <= 1 ? (names[0] ?? "Standard") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** The plan as short lines for the pricing cards. */
export function planLines(plan: Plan) {
  const lines: string[] = [];
  if (plan.freeHours !== null) lines.push(`${plan.freeHours} awake hours a month included`);
  if (plan.maxPreviews === null && plan.maxRepositories === null) lines.push("Unlimited previews and repositories");
  else {
    if (plan.maxPreviews !== null) lines.push(`${plural(plan.maxPreviews, "preview", "previews")} at a time`);
    if (plan.maxRepositories !== null) lines.push(plural(plan.maxRepositories, "repository", "repositories"));
  }
  if (plan.billed) lines.push(`Small ${rateLabel("small")}, Standard ${rateLabel("standard")}, Large ${rateLabel("large")}`);
  else if (plan.id !== "enterprise") lines.push(plan.sizes.includes("large") ? "All sizes" : `${sizeList(plan.sizes)} sizes`);
  return [...lines, ...plan.extras];
}

/** What going to `next` would leave over its limits right now. Running previews keep running either way. */
export function overLimits(next: Plan, usage: PlanUsage) {
  const over: string[] = [];
  if (next.maxPreviews !== null && usage.previews > next.maxPreviews) {
    over.push(`${usage.previews} previews are running and the ${next.name} allows ${next.maxPreviews}`);
  }
  if (next.maxRepositories !== null && usage.repositories > next.maxRepositories) {
    over.push(`previews are running for ${usage.repositories} repositories and the ${next.name} covers ${next.maxRepositories}`);
  }
  if (next.freeHours !== null && usage.standardHours >= next.freeHours) {
    over.push(`this month's ${Math.round(usage.standardHours)} awake hours are past the ${next.freeHours} it includes`);
  }
  return over;
}

// ---- the calculator ----

export type Estimate = {
  /** Awake hours a month, as they happen. */
  awakeHours: number;
  /** The same counted at Standard size, for the Sandbox's allowance. */
  standardHours: number;
  /** Pay as you go, per month. */
  mayfly: number;
  /** The same previews kept awake the whole time they're open. */
  alwaysOn: number;
  saving: number;
  /** Fits the Sandbox's monthly hours and sizes (its limits on previews at a time aside). */
  fitsSandbox: boolean;
};

/**
 * A month of previews: `pullRequests` opened a month, each looked at for `hoursAwake` hours in total and open for
 * `daysOpen` days. With Mayfly a preview is billed only while awake; kept always on, it would run all the days it's open.
 */
export function estimateBill(input: { pullRequests: number; size: PreviewSize; hoursAwake: number; daysOpen: number }): Estimate {
  const prs = Math.max(0, input.pullRequests);
  const openHours = Math.max(0, input.daysOpen) * 24;
  const hoursAwake = Math.min(Math.max(0, input.hoursAwake), openHours || Infinity);
  const rate = HOURLY_RATES[input.size];
  const weight = SIZE_INFO[input.size].weight;
  const awakeHours = prs * hoursAwake;
  const mayfly = awakeHours * rate;
  const alwaysOn = prs * openHours * rate;
  const standardHours = awakeHours * weight;
  return {
    awakeHours,
    standardHours,
    mayfly,
    alwaysOn,
    saving: Math.max(0, alwaysOn - mayfly),
    fitsSandbox: PLANS.sandbox.sizes.includes(input.size) && standardHours <= (PLANS.sandbox.freeHours ?? 0),
  };
}
