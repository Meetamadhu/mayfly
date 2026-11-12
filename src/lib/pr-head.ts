import { execFile } from "node:child_process";
import { childEnv } from "./builder";

const LOOKUP_LIMIT_MS = 15_000;

function validSha(value: unknown): string | null {
  const sha = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Prefer git ls-remote; fall back to the GitHub API (works when git is missing from PATH). */
function pullRequestHeadViaGit(repository: string, prNumber: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", `https://github.com/${repository}.git`, `refs/pull/${prNumber}/head`],
      { timeout: LOOKUP_LIMIT_MS, windowsHide: true, env: childEnv() },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(validSha(String(stdout).trim().split(/\s+/)[0]));
      },
    );
  });
}

async function pullRequestHeadViaApi(repository: string, prNumber: number): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mayfly",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = (process.env.GITHUB_TOKEN ?? process.env.MAYFLY_GITHUB_TOKEN ?? "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
      headers,
      signal: AbortSignal.timeout(LOOKUP_LIMIT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { head?: { sha?: string } };
    return validSha(body.head?.sha);
  } catch {
    return null;
  }
}

/** The commit a pull request points at on GitHub right now, or null if it cannot be found. */
export async function pullRequestHead(repository: string, prNumber: number): Promise<string | null> {
  return (await pullRequestHeadViaGit(repository, prNumber)) ?? pullRequestHeadViaApi(repository, prNumber);
}
