import { randomBytes } from "node:crypto";
import { buildsPullRequests, getConfig, repositoryAllowed } from "./config";
import { pullRequestHead, pullRequestHeadDetails } from "./pr-head";
import type { PullRequestEvent } from "./types";

/**
 * Fill empty sha / branch from the pull request's current head on GitHub so statuses and comments
 * attach to a real commit and branch. Docker builds require a real head; process/placeholder mode
 * still prefers it when lookup works, and only invents a random SHA when GitHub cannot be reached
 * (or for the demo). An empty branch always needs a real head ref — there is no invented branch.
 */
export async function resolveSimulatorRefs(
  event: PullRequestEvent,
): Promise<{ ok: true; sha: string; branch: string } | { ok: false; error: string }> {
  let sha = event.sha;
  let branch = event.branch;

  if (sha && branch) return { ok: true, sha, branch };

  const demo = getConfig().demo;
  const isDemo = Boolean(demo && demo.repository === event.repository && demo.prNumber === event.prNumber);
  const needsRealHead =
    event.action !== "closed" && !isDemo && (!buildsPullRequests() || repositoryAllowed(event.repository));

  if (!sha || !branch) {
    const details = await pullRequestHeadDetails(event.repository, event.prNumber);
    if (details) {
      if (!sha) sha = details.sha;
      if (!branch) branch = details.branch;
    }
  }

  if (!sha) {
    if (needsRealHead) {
      const head = await pullRequestHead(event.repository, event.prNumber);
      if (head) {
        sha = head;
      } else if (buildsPullRequests() && repositoryAllowed(event.repository)) {
        return {
          ok: false,
          error: `Could not find the head of PR #${event.prNumber} in ${event.repository}.`,
        };
      } else {
        sha = randomBytes(8).toString("hex");
      }
    } else {
      sha = randomBytes(8).toString("hex");
    }
  }

  if (!branch) {
    if (isDemo) {
      branch = "demo";
    } else {
      return {
        ok: false,
        error: `Could not find the head branch of PR #${event.prNumber} in ${event.repository}.`,
      };
    }
  }

  return { ok: true, sha, branch };
}
