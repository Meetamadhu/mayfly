import type { RepoUsage } from "./types";

/** Reading saved usage, shared by the JSON-file store and the MongoDB store. Damaged entries are dropped. */

const isTotal = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A day's split by repository. */
export function asRepoUsage(value: unknown): Record<string, RepoUsage> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, RepoUsage> = {};
  for (const [repository, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (!isTotal(raw.awakeSeconds) || !isTotal(raw.asleepSeconds)) continue;
    out[repository] = {
      awakeSeconds: raw.awakeSeconds,
      asleepSeconds: raw.asleepSeconds,
      ...(isTotal(raw.awakeWeighted) ? { awakeWeighted: raw.awakeWeighted } : {}),
      ...(isTotal(raw.asleepWeighted) ? { asleepWeighted: raw.asleepWeighted } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}
