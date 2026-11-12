import { randomBytes } from "node:crypto";
import { buildsPullRequests, getConfig, repositoryAllowed } from "./config";
import { expandPullRequestSha, pullRequestHead, pullRequestHeadDetails } from "./pr-head";
import { exclusive, loadState } from "./store";
import { isLiveStatus, type PullRequestEvent } from "./types";

async function livePreview(repository: string, prNumber: number) {
  const state = await exclusive(async () => loadState());
  return (
    state.environments.find(
      (env) => env.repository === repository && env.prNumber === prNumber && isLiveStatus(env.status),
    ) ?? null
  );
}

/**
 * Fill empty sha / branch from the pull request's current head on GitHub so statuses and comments
 * attach to a real commit and branch. Short typed SHAs are expanded to the full commit on the PR.
 * Closing never requires a branch or SHA lookup against GitHub.
 */
export async function resolveSimulatorRefs(
  event: PullRequestEvent,
): Promise<{ ok: true; sha: string; branch: string } | { ok: false; error: string }> {
  let sha = event.sha;
  let branch = event.branch;

  // Closing must not depend on GitHub. Prefer the live preview's branch/sha; otherwise placeholders.
  if (event.action === "closed") {
    if (!branch || !sha || sha.length < 40) {
      const live = await livePreview(event.repository, event.prNumber);
      if (!branch) branch = live?.branch || "-";
      if (!sha) {
        sha = live?.sha || randomBytes(8).toString("hex");
      } else if (sha.length < 40 && live?.sha?.startsWith(sha)) {
        sha = live.sha;
      }
    }
    return { ok: true, sha, branch };
  }

  const demo = getConfig().demo;
  const isDemo = Boolean(demo && demo.repository === event.repository && demo.prNumber === event.prNumber);
  const needsRealHead = !isDemo && (!buildsPullRequests() || repositoryAllowed(event.repository));

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

  if (sha.length > 0 && sha.length < 40) {
    const expanded = await expandPullRequestSha(event.repository, event.prNumber, sha);
    if (!expanded.ok) return expanded;
    sha = expanded.sha;
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
