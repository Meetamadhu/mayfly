import { randomBytes } from "node:crypto";
import { buildsPullRequests, getConfig, repositoryAllowed } from "./config";
import { pullRequestHead } from "./pr-head";
import type { PullRequestEvent } from "./types";

/**
 * No commit given: prefer the pull request's current head on GitHub so commit statuses and comments
 * attach to a real SHA. Docker builds require that head; process/placeholder mode still uses it when
 * lookup works, and only invents a random SHA when GitHub cannot be reached (or for the demo).
 */
export async function resolveSimulatorSha(
  event: PullRequestEvent,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if (event.sha) return { ok: true, sha: event.sha };

  const demo = getConfig().demo;
  const isDemo = Boolean(demo && demo.repository === event.repository && demo.prNumber === event.prNumber);
  const needsRealHead =
    event.action !== "closed" && !isDemo && (!buildsPullRequests() || repositoryAllowed(event.repository));
  if (needsRealHead) {
    const head = await pullRequestHead(event.repository, event.prNumber);
    if (head) {
      return { ok: true, sha: head };
    }
    if (buildsPullRequests() && repositoryAllowed(event.repository)) {
      return {
        ok: false,
        error: `Could not find the head of PR #${event.prNumber} in ${event.repository}.`,
      };
    }
    return { ok: true, sha: randomBytes(8).toString("hex") };
  }
  return { ok: true, sha: randomBytes(8).toString("hex") };
}
