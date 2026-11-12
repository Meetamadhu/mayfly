import { execFile } from "node:child_process";
import { childEnv } from "./builder";

const LOOKUP_LIMIT_MS = 15_000;

export type PullRequestHeadDetails = {
  sha: string;
  branch: string;
};

function validSha(value: unknown): string | null {
  const sha = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function validBranch(value: unknown): string | null {
  const branch = String(value ?? "").trim();
  if (!branch || branch.length > 200 || /\s/.test(branch)) return null;
  return branch;
}

function lsRemote(repository: string, ...refs: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", `https://github.com/${repository}.git`, ...refs],
      { timeout: LOOKUP_LIMIT_MS, windowsHide: true, env: childEnv() },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(String(stdout));
      },
    );
  });
}

/** Prefer git ls-remote for the PR head SHA alone. */
function pullRequestHeadViaGit(repository: string, prNumber: number): Promise<string | null> {
  return lsRemote(repository, `refs/pull/${prNumber}/head`).then((stdout) => {
    if (!stdout) return null;
    return validSha(stdout.trim().split(/\s+/)[0]);
  });
}

/**
 * When the API is unavailable: ls-remote the repo, take refs/pull/<n>/head's SHA, then the single
 * refs/heads/* branch that points at that SHA. None or several matching heads → null.
 */
async function pullRequestHeadViaGitDetails(
  repository: string,
  prNumber: number,
): Promise<PullRequestHeadDetails | null> {
  const stdout = await lsRemote(repository);
  if (!stdout) return null;

  const pullRef = `refs/pull/${prNumber}/head`;
  let headSha: string | null = null;
  const headsBySha = new Map<string, string[]>();

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawSha, ref] = trimmed.split(/\s+/);
    const sha = validSha(rawSha);
    if (!sha || !ref) continue;
    if (ref === pullRef) headSha = sha;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!validBranch(name)) continue;
      const list = headsBySha.get(sha) ?? [];
      list.push(name);
      headsBySha.set(sha, list);
    }
  }

  if (!headSha) return null;
  const matches = headsBySha.get(headSha) ?? [];
  if (matches.length !== 1) return null;
  return { sha: headSha, branch: matches[0] };
}

async function pullRequestHeadViaApi(repository: string, prNumber: number): Promise<PullRequestHeadDetails | null> {
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
    const body = (await response.json()) as { head?: { sha?: string; ref?: string } };
    const sha = validSha(body.head?.sha);
    const branch = validBranch(body.head?.ref);
    if (!sha || !branch) return null;
    return { sha, branch };
  } catch {
    return null;
  }
}

/** SHA + branch of a pull request head. API first; git ls-remote branch match as fallback. */
export async function pullRequestHeadDetails(
  repository: string,
  prNumber: number,
): Promise<PullRequestHeadDetails | null> {
  return (await pullRequestHeadViaApi(repository, prNumber)) ?? pullRequestHeadViaGitDetails(repository, prNumber);
}

/** The commit a pull request points at on GitHub right now, or null if it cannot be found. */
export async function pullRequestHead(repository: string, prNumber: number): Promise<string | null> {
  return (
    (await pullRequestHeadViaGit(repository, prNumber)) ??
    (await pullRequestHeadViaApi(repository, prNumber))?.sha ??
    null
  );
}
