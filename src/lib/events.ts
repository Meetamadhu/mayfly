import type { PullRequestEvent } from "./types";

const ACTIONS = new Set<PullRequestEvent["action"]>(["opened", "synchronize", "closed", "reopened"]);

export function parseSimulatorEvent(
  input: unknown,
): { ok: true; event: PullRequestEvent; wait: boolean } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Expected a JSON object." };
  }

  const body = input as Record<string, unknown>;
  const action = body.action;
  const repository = typeof body.repository === "string" ? body.repository.trim().toLowerCase() : "";
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  const sha = typeof body.sha === "string" ? body.sha.trim().toLowerCase() : "";
  const prNumber = typeof body.prNumber === "number" ? body.prNumber : Number(body.prNumber);

  if (typeof action !== "string" || !ACTIONS.has(action as PullRequestEvent["action"])) {
    return { ok: false, error: "Action must be opened, synchronize, closed, or reopened." };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return { ok: false, error: "Repository must look like owner/name." };
  }
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > 1_000_000) {
    return { ok: false, error: "Pull request number must be a positive integer." };
  }
  if (!/^[0-9a-f]{7,64}$/.test(sha)) {
    return { ok: false, error: "SHA must be 7 to 64 hex characters." };
  }
  if (!branch || branch.length > 200 || /\s/.test(branch)) {
    return { ok: false, error: "Branch must be a single token up to 200 characters." };
  }

  let ttlMinutes: number | undefined;
  if (body.ttlMinutes !== undefined && body.ttlMinutes !== null && body.ttlMinutes !== "") {
    const parsed = typeof body.ttlMinutes === "number" ? body.ttlMinutes : Number(body.ttlMinutes);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 7 * 24 * 60) {
      return { ok: false, error: "TTL minutes must be between 0 and 10080." };
    }
    ttlMinutes = parsed;
  }

  return {
    ok: true,
    wait: body.wait === true,
    event: {
      action: action as PullRequestEvent["action"],
      repository,
      prNumber,
      sha,
      branch,
      merged: body.merged === true,
      ttlMinutes,
    },
  };
}
