import express, { Router } from "express";
import { randomBytes } from "node:crypto";
import { buildsPullRequests, repositoryAllowed } from "@/lib/config";
import { applyPullRequestEvent } from "@/lib/lifecycle";
import { parseNewPreview } from "@/lib/new-preview";
import { openPullRequestForBranch, pullRequestHeadDetails } from "@/lib/pr-head";
import { exclusive, loadState } from "@/lib/store";
import { isLiveStatus } from "@/lib/types";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson, sendLifecycle } from "../lib/respond";

/**
 * POST /api/previews: an admin starts a preview of a branch by hand, with a size, a lifetime and a budget. The
 * branch must have an open pull request (found automatically when no number is given), so the preview is an
 * ordinary pull request preview from then on: new commits update it and closing the pull request removes it.
 */
export const previewsRouter = Router();

const json = express.json({ limit: "16kb" });

previewsRouter.post(
  "/api/previews",
  requireAdmin,
  (req, res, next) =>
    json(req, res, (err?: unknown) => {
      if (err) {
        sendJson(res, { ok: false, code: "invalid", error: "Request body must be JSON." }, 400);
        return;
      }
      next();
    }),
  asyncHandler(async (req, res) => {
    const parsed = parseNewPreview(req.body);
    if (!parsed.ok) {
      sendJson(res, { ok: false, code: "invalid", error: parsed.error }, 400);
      return;
    }
    const { repository, branch, title, size, ttlHours, budget } = parsed.request;
    const realBuilds = buildsPullRequests();
    if (realBuilds && !repositoryAllowed(repository)) {
      sendJson(res, { ok: false, code: "invalid", error: `${repository} isn't on Mayfly's list of allowed repositories (PREVIEW_REPOS).` }, 400);
      return;
    }

    // Which pull request, and its current commit.
    let prNumber = parsed.request.prNumber;
    let sha = "";
    if (prNumber !== null) {
      const head = await pullRequestHeadDetails(repository, prNumber);
      if (head) {
        if (head.branch !== branch) {
          sendJson(res, { ok: false, code: "invalid", error: `Pull request #${prNumber} is for the branch ${head.branch}, not ${branch}.` }, 400);
          return;
        }
        sha = head.sha;
      } else if (realBuilds) {
        sendJson(res, { ok: false, code: "invalid", error: `Couldn't find pull request #${prNumber} in ${repository}.` }, 400);
        return;
      }
    } else {
      const found = await openPullRequestForBranch(repository, branch);
      if (found) {
        prNumber = found.prNumber;
        sha = found.sha;
      } else {
        sendJson(
          res,
          { ok: false, code: "invalid", error: `There's no open pull request for ${branch} in ${repository}. Open one on GitHub, or enter its number.` },
          400,
        );
        return;
      }
    }
    // Simulated previews (the demo site) don't build code, so any commit id will do there.
    if (!sha) sha = randomBytes(20).toString("hex");

    const existing = await exclusive(async () => {
      const state = await loadState();
      return state.environments.find((env) => env.repository === repository && env.prNumber === prNumber && isLiveStatus(env.status)) ?? null;
    });
    if (existing) {
      sendJson(res, { ok: false, code: "conflict", error: `Pull request #${prNumber} already has a preview.`, environment: existing }, 409);
      return;
    }

    const result = await applyPullRequestEvent({
      action: "opened",
      repository,
      prNumber,
      sha,
      branch,
      ...(title ? { title } : {}),
      ...(ttlHours !== null ? { ttlMinutes: ttlHours * 60 } : {}),
      size,
      ...(budget !== null ? { budget } : {}),
    });
    sendLifecycle(res, result);
  }),
);
