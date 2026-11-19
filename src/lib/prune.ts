import type { Environment } from "./types";

/**
 * Mayfly keeps all of its state in one MongoDB document (or one JSON file), and MongoDB caps a document at
 * 16 MB. Without a limit the state only grows: every removed preview stays, and every PR comment edit is
 * kept. These limits keep it small for good.
 */

/** Removed previews are forgotten this long after removal. The Cost page looks back 30 days. */
export const KEEP_REMOVED_DAYS = 60;
/** Versions of the PR comment kept per preview (the PR comments page shows them as earlier versions). */
export const KEEP_COMMENT_VERSIONS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneResult {
  environments: Environment[];
  removedRecords: number;
  trimmedComments: number;
}

/** Drop old removed previews and old comment versions. Live previews are never dropped. */
export function pruneEnvironments(environments: Environment[], now: number): PruneResult {
  const cutoff = now - KEEP_REMOVED_DAYS * DAY_MS;
  let removedRecords = 0;
  let trimmedComments = 0;
  const kept: Environment[] = [];
  for (const env of environments) {
    if (env.status === "destroyed") {
      const removedAt = Date.parse(env.destroyedAt ?? env.updatedAt);
      if (Number.isFinite(removedAt) && removedAt < cutoff) {
        removedRecords += 1;
        continue;
      }
    }
    if (env.comments.length > KEEP_COMMENT_VERSIONS) {
      trimmedComments += env.comments.length - KEEP_COMMENT_VERSIONS;
      env.comments = env.comments.slice(-KEEP_COMMENT_VERSIONS);
    }
    kept.push(env);
  }
  return { environments: kept, removedRecords, trimmedComments };
}
