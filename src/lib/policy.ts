/**
 * TTL and sleep policies set from the TTL policies page. Saved with the rest of Mayfly's state and kept in
 * memory here so config lookups stay synchronous. Anything not set falls back to the environment variables.
 *
 * This module imports nothing from config or lifecycle, so both can use it without an import cycle.
 */

export const DEFAULT_KEEP_LABEL = "keep-preview";
export const WARN_MINUTE_CHOICES = [0, 30, 60, 120, 360, 1440] as const;
export const MAX_REPO_RULES = 50;

export const LIMITS = {
  ttlHours: { min: 1, max: 720 },
  sleepSeconds: { min: 5, max: 86_400 },
  maxExtensions: { min: 0, max: 20 },
} as const;

export interface RepoPolicyRule {
  /** owner/name, lower case. */
  repository: string;
  /** Lifetime for this repo's previews, in hours. Null: use the default lifetime. */
  ttlHours: number | null;
  /** Idle seconds before this repo's previews sleep. Null: use the default. */
  sleepSeconds: number | null;
}

export interface PreviewPolicy {
  /** Default lifetime in hours. Null: PREVIEW_TTL_HOURS. */
  ttlHours: number | null;
  /** Default idle seconds before sleep. Null: PREVIEW_SLEEP_SECONDS. */
  sleepSeconds: number | null;
  /** How many times one preview may be extended. Null: no limit. */
  maxExtensions: number | null;
  /** PR label that stops a preview expiring while the PR is open. Empty: off. */
  keepLabel: string;
  /** Post a warning on the PR this many minutes before a preview expires. 0: off. */
  warnMinutes: number;
  repoRules: RepoPolicyRule[];
  updatedAt: string | null;
}

export function defaultPolicy(): PreviewPolicy {
  return {
    ttlHours: null,
    sleepSeconds: null,
    maxExtensions: null,
    keepLabel: DEFAULT_KEEP_LABEL,
    warnMinutes: 0,
    repoRules: [],
    updatedAt: null,
  };
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function wholeNumberIn(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) return undefined;
  return number;
}

/** A label name as GitHub allows it: 1–50 characters, no control characters. Empty means off. */
function labelName(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 50 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

export type PolicyParse = { ok: true; policy: PreviewPolicy } | { ok: false; error: string };

/**
 * Check a policy sent from the page (or read back from storage). Every field must be valid; nothing is
 * silently clamped, so the page shows exactly what was saved.
 */
export function parsePolicy(input: unknown, updatedAt: string | null = null): PolicyParse {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send a policy object." };
  const raw = input as Record<string, unknown>;

  const ttlHours = wholeNumberIn(raw.ttlHours, LIMITS.ttlHours.min, LIMITS.ttlHours.max);
  if (ttlHours === undefined) {
    return { ok: false, error: `Default lifetime must be ${LIMITS.ttlHours.min}–${LIMITS.ttlHours.max} hours.` };
  }
  const sleepSeconds = wholeNumberIn(raw.sleepSeconds, LIMITS.sleepSeconds.min, LIMITS.sleepSeconds.max);
  if (sleepSeconds === undefined) {
    return {
      ok: false,
      error: `Sleep after must be ${LIMITS.sleepSeconds.min}–${LIMITS.sleepSeconds.max} seconds.`,
    };
  }
  const maxExtensions = wholeNumberIn(raw.maxExtensions, LIMITS.maxExtensions.min, LIMITS.maxExtensions.max);
  if (maxExtensions === undefined) {
    return { ok: false, error: `Extension limit must be ${LIMITS.maxExtensions.min}–${LIMITS.maxExtensions.max}.` };
  }
  const keepLabel = labelName(raw.keepLabel);
  if (keepLabel === undefined) return { ok: false, error: "Keep label must be up to 50 characters." };
  const warnRaw = raw.warnMinutes ?? 0;
  const warnMinutes = typeof warnRaw === "string" && /^\d+$/.test(warnRaw) ? Number(warnRaw) : warnRaw;
  if (!WARN_MINUTE_CHOICES.includes(warnMinutes as (typeof WARN_MINUTE_CHOICES)[number])) {
    return { ok: false, error: "Pick an expiry warning from the list." };
  }

  const rulesRaw = raw.repoRules ?? [];
  if (!Array.isArray(rulesRaw)) return { ok: false, error: "Repository rules must be a list." };
  if (rulesRaw.length > MAX_REPO_RULES) return { ok: false, error: `At most ${MAX_REPO_RULES} repository rules.` };
  const repoRules: RepoPolicyRule[] = [];
  const seen = new Set<string>();
  for (const entry of rulesRaw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each repository rule needs a repository." };
    const rule = entry as Record<string, unknown>;
    const repository = typeof rule.repository === "string" ? rule.repository.trim().toLowerCase() : "";
    if (!REPO_PATTERN.test(repository)) {
      return { ok: false, error: `“${String(rule.repository ?? "").slice(0, 80)}” is not owner/name.` };
    }
    if (seen.has(repository)) return { ok: false, error: `${repository} has two rules. Keep one.` };
    seen.add(repository);
    const ruleTtl = wholeNumberIn(rule.ttlHours, LIMITS.ttlHours.min, LIMITS.ttlHours.max);
    if (ruleTtl === undefined) {
      return {
        ok: false,
        error: `${repository}: lifetime must be ${LIMITS.ttlHours.min}–${LIMITS.ttlHours.max} hours.`,
      };
    }
    const ruleSleep = wholeNumberIn(rule.sleepSeconds, LIMITS.sleepSeconds.min, LIMITS.sleepSeconds.max);
    if (ruleSleep === undefined) {
      return {
        ok: false,
        error: `${repository}: sleep after must be ${LIMITS.sleepSeconds.min}–${LIMITS.sleepSeconds.max} seconds.`,
      };
    }
    if (ruleTtl === null && ruleSleep === null) {
      return { ok: false, error: `${repository}: set a lifetime, a sleep time, or remove the rule.` };
    }
    repoRules.push({ repository, ttlHours: ruleTtl, sleepSeconds: ruleSleep });
  }

  return {
    ok: true,
    policy: { ttlHours, sleepSeconds, maxExtensions, keepLabel, warnMinutes: warnMinutes as number, repoRules, updatedAt },
  };
}

/** Read a stored policy. A damaged one is dropped (the env defaults apply) rather than breaking state. */
export function asStoredPolicy(value: unknown): PreviewPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  const parsed = parsePolicy(value, typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt)) ? updatedAt : null);
  return parsed.ok ? parsed.policy : undefined;
}

const holder = globalThis as unknown as { __mayflyPolicy?: PreviewPolicy };

/** The policy in effect. Set at startup, on every reaper tick, and on save. */
export function currentPolicy(): PreviewPolicy {
  return holder.__mayflyPolicy ?? defaultPolicy();
}

export function setCurrentPolicy(policy: PreviewPolicy | undefined) {
  holder.__mayflyPolicy = policy ?? defaultPolicy();
}

export function repoRuleFor(repository: string): RepoPolicyRule | null {
  const key = repository.trim().toLowerCase();
  return currentPolicy().repoRules.find((rule) => rule.repository === key) ?? null;
}

/** True when the pull request carries the keep label (case-insensitive, as GitHub treats label names). */
export function hasKeepLabel(labels: string[] | undefined): boolean {
  const label = currentPolicy().keepLabel.toLowerCase();
  if (!label || !labels) return false;
  return labels.some((name) => name.trim().toLowerCase() === label);
}
