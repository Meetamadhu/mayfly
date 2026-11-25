import { cleanTitle } from "./github";
import { isPreviewSize, type PreviewSize } from "./sizes";

/**
 * The "New preview" form's request, checked: which repository and branch, an optional pull request number,
 * a description, a size, a lifetime and a budget.
 */

export type NewPreviewRequest = {
  repository: string;
  branch: string;
  prNumber: number | null;
  title: string | undefined;
  size: PreviewSize;
  ttlHours: number | null;
  budget: number | null;
};

/** Lifetimes the form offers, in hours. Null means the repository's usual lifetime. */
export const LIFETIME_CHOICES = [4, 24, 72, 168] as const;
/** Budgets the form offers, in the configured currency. Null means no limit. */
export const BUDGET_CHOICES = [1, 5, 10, 25] as const;

export function parseNewPreview(input: unknown): { ok: true; request: NewPreviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Expected a JSON object." };
  const body = input as Record<string, unknown>;
  const repository = typeof body.repository === "string" ? body.repository.trim().toLowerCase() : "";
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return { ok: false, error: "Choose a repository (owner/name)." };
  if (!branch) return { ok: false, error: "Enter the branch to preview." };
  if (branch.length > 200 || /\s/.test(branch) || branch.startsWith("-")) {
    return { ok: false, error: "That doesn't look like a branch name." };
  }

  let prNumber: number | null = null;
  if (body.prNumber !== undefined && body.prNumber !== null && body.prNumber !== "") {
    const value = Number(body.prNumber);
    if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
      return { ok: false, error: "The pull request number should be a whole number, like 42." };
    }
    prNumber = value;
  }

  const size = body.size === undefined || body.size === null || body.size === "" ? "standard" : body.size;
  if (!isPreviewSize(size)) return { ok: false, error: "Choose Small, Standard or Large." };

  let ttlHours: number | null = null;
  if (body.ttlHours !== undefined && body.ttlHours !== null && body.ttlHours !== "") {
    const value = Number(body.ttlHours);
    if (!Number.isFinite(value) || value < 1 || value > 168) {
      return { ok: false, error: "The lifetime should be between 1 hour and 7 days." };
    }
    ttlHours = value;
  }

  let budget: number | null = null;
  if (body.budget !== undefined && body.budget !== null && body.budget !== "") {
    const value = Number(body.budget);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
      return { ok: false, error: "The budget should be more than 0 and at most 1000." };
    }
    budget = Math.round(value * 100) / 100;
  }

  return { ok: true, request: { repository, branch, prNumber, title: cleanTitle(body.title), size, ttlHours, budget } };
}
