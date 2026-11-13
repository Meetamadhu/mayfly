import { getConfig } from "./config";

const GITHUB_API = {
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "mayfly",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

/** Hidden first line so Mayfly can find its own comment again. */
export const MAYFLY_COMMENT_MARKER = "<!-- mayfly-preview -->";

function githubApiBase() {
  return (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
}

function githubHeaders(token: string) {
  return {
    ...GITHUB_API,
    Authorization: `Bearer ${token}`,
  };
}

function withMarker(body: string) {
  const trimmed = body.trimStart();
  if (trimmed.startsWith(MAYFLY_COMMENT_MARKER)) return trimmed;
  return `${MAYFLY_COMMENT_MARKER}\n${body.trim()}`;
}

/** Cached login for the configured token. undefined = not cached yet (failures are not cached). */
let cachedLogin: string | undefined;

/** Test helper: clear the cached /user login. */
export function resetGithubLoginCache() {
  cachedLogin = undefined;
}

async function ownLogin(token: string): Promise<string | null> {
  if (cachedLogin !== undefined) return cachedLogin;
  try {
    const response = await fetch(`${githubApiBase()}/user`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { login?: unknown };
    const login = typeof body.login === "string" ? body.login.trim() : "";
    // Only cache a real login — a brief network/API failure must not stick.
    if (!login) return null;
    cachedLogin = login;
    return cachedLogin;
  } catch {
    return null;
  }
}

type IssueComment = {
  id: number;
  body?: string;
  user?: { login?: string };
  created_at?: string;
};

async function listIssueComments(repository: string, prNumber: number, token: string): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(
      `${githubApiBase()}/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub list comments failed (${response.status}): ${text.slice(0, 180)}`);
    }
    const batch = (await response.json()) as IssueComment[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

/**
 * Newest Mayfly comment on this PR that was written by the token's own account.
 * Never returns another user's comment, even if it contains the marker.
 */
async function findOwnMayflyComment(
  repository: string,
  prNumber: number,
  token: string,
): Promise<number | null> {
  const login = await ownLogin(token);
  if (!login) return null;

  const comments = await listIssueComments(repository, prNumber, token);
  let best: IssueComment | null = null;
  for (const comment of comments) {
    if (!comment || typeof comment.id !== "number") continue;
    if (comment.user?.login !== login) continue;
    if (typeof comment.body !== "string" || !comment.body.includes(MAYFLY_COMMENT_MARKER)) continue;
    if (!best || comment.id > best.id) best = comment;
  }
  return best?.id ?? null;
}

async function postComment(
  repository: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<number> {
  const response = await fetch(`${githubApiBase()}/repos/${repository}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub comment failed (${response.status}): ${text.slice(0, 180)}`);
  }
  const created = (await response.json()) as { id?: unknown };
  if (typeof created.id !== "number") {
    throw new Error("GitHub comment failed: response missing id.");
  }
  return created.id;
}

/**
 * Edit an existing issue comment. Returns "missing" on 404 so the caller can post a new one.
 */
async function patchComment(
  repository: string,
  commentId: number,
  body: string,
  token: string,
): Promise<"ok" | "missing"> {
  const response = await fetch(`${githubApiBase()}/repos/${repository}/issues/comments/${commentId}`, {
    method: "PATCH",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return "missing";
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub comment edit failed (${response.status}): ${text.slice(0, 180)}`);
  }
  return "ok";
}

/**
 * Keep one Mayfly comment per pull request: edit in place when possible, otherwise post.
 * Returns the comment id to store on the environment, or null when no token is configured.
 */
export async function publishPullRequestComment(
  repository: string,
  prNumber: number,
  body: string,
  commentId?: number | null,
): Promise<number | null> {
  const token = getConfig().githubToken;
  if (!token) return null;

  const marked = withMarker(body);
  let id =
    typeof commentId === "number" && Number.isInteger(commentId) && commentId > 0 ? commentId : null;

  if (!id) {
    id = await findOwnMayflyComment(repository, prNumber, token);
  }

  if (id) {
    const result = await patchComment(repository, id, marked, token);
    if (result === "ok") return id;
    // Comment was deleted — fall through and post a replacement.
  }

  return postComment(repository, prNumber, marked, token);
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
  const response = await fetch(`${githubApiBase()}/repos/${repository}/statuses/${encodeURIComponent(fullSha)}`, {
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
