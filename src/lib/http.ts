import { getConfig } from "./config";
import type { LifecycleResult } from "./types";

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function resultResponse(result: LifecycleResult) {
  if (result.ok) return json(result);
  const status = {
    invalid: 400,
    not_found: 404,
    cap: 409,
    conflict: 409,
    deploy_failed: 502,
  }[result.code];
  return json(result, status);
}

const GITHUB_API = {
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "mayfly",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function githubHeaders(token: string) {
  return {
    ...GITHUB_API,
    Authorization: `Bearer ${token}`,
  };
}

export async function publishPullRequestComment(repository: string, prNumber: number, body: string) {
  const token = getConfig().githubToken;
  if (!token) return;

  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub comment failed (${response.status}): ${text.slice(0, 180)}`);
  }
}

export type CommitStatusState = "error" | "failure" | "pending" | "success";

/** Posts a commit status that shows on the pull request as a Mayfly check. Needs `repo:status` (or `repo`). */
export async function publishCommitStatus(
  repository: string,
  sha: string,
  input: {
    state: CommitStatusState;
    description: string;
    targetUrl?: string | null;
    /** Stable context so pending → success/failure updates the same row. */
    context?: string;
  },
) {
  const token = getConfig().githubToken;
  const fullSha = sha.trim().toLowerCase();
  // Statuses API needs a real 40-char commit that exists in the repo (simulator random SHAs do not).
  if (!token || !/^[0-9a-f]{40}$/.test(fullSha)) return;

  const description = input.description.slice(0, 140);
  const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${encodeURIComponent(fullSha)}`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      state: input.state,
      description,
      context: input.context ?? "Mayfly — Preview",
      ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub status failed (${response.status}): ${text.slice(0, 180)}`);
  }
}
