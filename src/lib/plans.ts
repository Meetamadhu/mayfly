import { isLiveStatus, type Environment } from "./types";
import { PREVIEW_SIZES, SIZE_INFO, type PreviewSize } from "./sizes";

/**
 * Plans: what an install of Mayfly may run at once. This is a demo pricing module: changing plan is a demo
 * checkout that switches straight away, and no payment is taken.
 *
 * A plan limits three things, all checked when a new preview would start (previews already running are never
 * stopped by a plan change):
 *   - previews at a time (live previews: building, awake or asleep)
 *   - repositories with previews at a time
 *   - the sizes a preview may use
 */

export type PlanId = "free" | "team" | "business";

export const PLAN_IDS: PlanId[] = ["free", "team", "business"];

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in rupees; 0 is free. */
  price: number;
  blurb: string;
  /** null: no limit. */
  maxPreviews: number | null;
  maxRepositories: number | null;
  sizes: PreviewSize[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    blurb: "Try Mayfly on one project.",
    maxPreviews: 3,
    maxRepositories: 1,
    sizes: ["small", "standard"],
  },
  team: {
    id: "team",
    name: "Team",
    price: 999,
    blurb: "For a team that opens pull requests every day.",
    maxPreviews: 15,
    maxRepositories: 5,
    sizes: ["small", "standard", "large"],
  },
  business: {
    id: "business",
    name: "Business",
    price: 2999,
    blurb: "For several teams and many repositories.",
    maxPreviews: null,
    maxRepositories: null,
    sizes: ["small", "standard", "large"],
  },
};

/**
 * The plan an install is on before anyone picks one. Team, so installs that were running before plans existed
 * keep working exactly as they did.
 */
export const DEFAULT_PLAN: PlanId = "team";

/** The saved plan. `demo` is always true: no payment was taken to get it. */
export type StoredPlan = { id: PlanId; since: string; demo: true };

export function isPlanId(value: unknown): value is PlanId {
  return value === "free" || value === "team" || value === "business";
}

/** A saved plan if it's well formed, otherwise nothing (and the default applies). */
export function asStoredPlan(value: unknown): StoredPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<StoredPlan>;
  if (!isPlanId(raw.id) || typeof raw.since !== "string" || Number.isNaN(Date.parse(raw.since))) return undefined;
  return { id: raw.id, since: raw.since, demo: true };
}

export function currentPlan(stored: StoredPlan | undefined): Plan {
  return PLANS[stored?.id ?? DEFAULT_PLAN];
}

/** ₹999 with Indian digit grouping (₹1,999, ₹1,00,000). */
export function formatPrice(rupees: number) {
  return `₹${Math.round(Math.max(0, rupees)).toLocaleString("en-IN")}`;
}

/** Previews that count towards a plan: live ones, not being removed, not the built-in demo. */
export function countedPreviews(environments: Environment[], isDemo: (env: Environment) => boolean = () => false) {
  return environments.filter((env) => isLiveStatus(env.status) && env.status !== "destroying" && !isDemo(env));
}

export type PlanUsage = { previews: number; repositories: number };

export function planUsage(environments: Environment[], isDemo?: (env: Environment) => boolean): PlanUsage {
  const counted = countedPreviews(environments, isDemo);
  return { previews: counted.length, repositories: new Set(counted.map((env) => env.repository)).size };
}

export type PlanCheck = { ok: true; size: PreviewSize } | { ok: false; error: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether a new preview may start on this plan, and the size it gets.
 * - `size`: chosen by hand. A size the plan doesn't include is refused.
 * - `defaultSize`: from the repository's preview settings. A size the plan doesn't include falls back to Standard,
 *   so a plan change never stops a repository's previews from building.
 */
export function checkNewPreview(
  plan: Plan,
  environments: Environment[],
  request: { repository: string; size?: PreviewSize | null; defaultSize?: PreviewSize | null },
  isDemo?: (env: Environment) => boolean,
): PlanCheck {
  const counted = countedPreviews(environments, isDemo);
  if (plan.maxPreviews !== null && counted.length >= plan.maxPreviews) {
    return {
      ok: false,
      error: `The ${plan.name} plan runs ${plural(plan.maxPreviews, "preview", "previews")} at a time, and ${counted.length} ${counted.length === 1 ? "is" : "are"} running. Close a pull request, or change to a bigger plan.`,
    };
  }
  const repositories = new Set(counted.map((env) => env.repository));
  if (plan.maxRepositories !== null && !repositories.has(request.repository) && repositories.size >= plan.maxRepositories) {
    return {
      ok: false,
      error: `The ${plan.name} plan covers ${plural(plan.maxRepositories, "repository", "repositories")} at a time, and previews are running for ${[...repositories].sort().join(", ")}. Close those pull requests, or change to a bigger plan.`,
    };
  }
  if (request.size && !plan.sizes.includes(request.size)) {
    return {
      ok: false,
      error: `${SIZE_INFO[request.size].label} previews aren't part of the ${plan.name} plan. Pick ${sizeList(plan.sizes)}, or change to a bigger plan.`,
    };
  }
  const fallback = request.defaultSize && plan.sizes.includes(request.defaultSize) ? request.defaultSize : "standard";
  return { ok: true, size: request.size ?? fallback };
}

function sizeList(sizes: PreviewSize[]) {
  const names = PREVIEW_SIZES.filter((size) => sizes.includes(size)).map((size) => SIZE_INFO[size].label);
  return names.length <= 1 ? (names[0] ?? "Standard") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** The plan's limits as short lines for the pricing page. */
export function planLines(plan: Plan) {
  return [
    plan.maxPreviews === null ? "Unlimited previews at a time" : `${plural(plan.maxPreviews, "preview", "previews")} at a time`,
    plan.maxRepositories === null ? "Unlimited repositories" : plural(plan.maxRepositories, "repository", "repositories"),
    plan.sizes.includes("large") ? "All sizes, including Large" : `${sizeList(plan.sizes)} sizes`,
  ];
}

/** What going to `next` would leave over its limits right now. Running previews keep running either way. */
export function overLimits(next: Plan, usage: PlanUsage) {
  const over: string[] = [];
  if (next.maxPreviews !== null && usage.previews > next.maxPreviews) {
    over.push(`${usage.previews} previews are running and ${next.name} allows ${next.maxPreviews}`);
  }
  if (next.maxRepositories !== null && usage.repositories > next.maxRepositories) {
    over.push(`previews are running for ${usage.repositories} repositories and ${next.name} covers ${next.maxRepositories}`);
  }
  return over;
}
