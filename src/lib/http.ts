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

export async function publishPullRequestComment(repository: string, prNumber: number, body: string) {
  const token = getConfig().githubToken;
  if (!token) return;

  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "preview-orchestrator",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub comment failed (${response.status}): ${text.slice(0, 180)}`);
  }
}
