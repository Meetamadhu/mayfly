import express, { Router, type Request, type Response } from "express";
import { checkAdmin } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import { feedbackKey, feedbackKeyMatches, feedbackLink, parseFeedback } from "@/lib/feedback";
import { addFeedback, deleteFeedback, getLivePreview } from "@/lib/lifecycle";
import type { Environment } from "@/lib/types";
import { asyncHandler, sendJson } from "../lib/respond";

/**
 * Feedback on a preview, for the review page (/review/<owner>/<name>/<pr>):
 *   GET    /api/feedback/:owner/:name/:pr        the preview and its comments
 *   POST   /api/feedback/:owner/:name/:pr        add a comment
 *   DELETE /api/feedback/:owner/:name/:pr/:id    remove a comment (admins only)
 * Signed-in admins may always comment; anyone else needs the preview's feedback key in the
 * x-mayfly-feedback-key header. A custom header can't be sent from another site without CORS, which Mayfly
 * doesn't allow, so other sites can't post comments as a visitor.
 */
export const feedbackRouter = Router();

const KEY_HEADER = "x-mayfly-feedback-key";
const json = express.json({ limit: "16kb" });

// At most 20 comments per preview in 10 minutes, so a leaked link can't flood the pull request.
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 20;
const recent = new Map<string, number[]>();

function allowedNow(envId: string, now = Date.now()) {
  const times = (recent.get(envId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (times.length >= PER_WINDOW) {
    recent.set(envId, times);
    return false;
  }
  times.push(now);
  recent.set(envId, times);
  return true;
}

function headerOf(req: Request) {
  return (name: string): string | null => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
}

function isAdmin(req: Request) {
  return checkAdmin({ method: req.method, header: headerOf(req) }) === null;
}

function param(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** The live preview named in the URL, or a 404 already sent. */
async function previewFromUrl(req: Request, res: Response): Promise<Environment | null> {
  const pr = param(req.params.pr);
  let repository = "";
  try {
    repository = `${decodeURIComponent(param(req.params.owner))}/${decodeURIComponent(param(req.params.name))}`;
  } catch {
    repository = "";
  }
  const env = /^\d{1,9}$/.test(pr) && repository.length < 200 ? await getLivePreview(repository, Number(pr)) : null;
  if (!env) {
    sendJson(
      res,
      { ok: false, code: "not_found", error: "There's no live preview for this pull request. It may have been closed or removed." },
      404,
    );
    return null;
  }
  return env;
}

/** Who is asking: an admin, a holder of this preview's link, or nobody (a 401/403 is already sent). */
function access(req: Request, res: Response, env: Environment): "admin" | "link" | null {
  if (isAdmin(req)) return "admin";
  const given = (headerOf(req)(KEY_HEADER) ?? "").trim();
  if (given && feedbackKeyMatches(env.id, given)) return "link";
  // A signed-in admin whose request failed only the Origin check gets the admin guard's own answer.
  const denied = checkAdmin({ method: req.method, header: headerOf(req) });
  if (denied?.status === 403) {
    sendJson(res, denied.body, 403);
    return null;
  }
  sendJson(
    res,
    {
      ok: false,
      code: "unauthorized",
      error: feedbackKey(env.id)
        ? "Ask the team for the link on the pull request. A link stops working when its preview is removed or the admin token is changed."
        : "Feedback links are off because Mayfly has no admin token. Sign in as an admin to comment.",
    },
    401,
  );
  return null;
}

function previewView(env: Environment) {
  const [owner, name] = env.repository.split("/");
  return {
    id: env.id,
    repository: env.repository,
    prNumber: env.prNumber,
    title: env.title ?? null,
    branch: env.branch,
    sha: env.sha,
    status: env.status,
    // Relative, so the review page frames the preview on whichever address it was opened on.
    path: `/p/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${env.prNumber}/`,
  };
}

const ROUTE = "/api/feedback/:owner/:name/:pr";

feedbackRouter.get(
  ROUTE,
  asyncHandler(async (req, res) => {
    const env = await previewFromUrl(req, res);
    if (!env) return;
    const who = access(req, res, env);
    if (!who) return;
    sendJson(res, {
      ok: true,
      admin: who === "admin",
      preview: previewView(env),
      items: env.feedback ?? [],
      postsToGithub: Boolean(getConfig().githubToken),
      ...(who === "admin" ? { link: feedbackLink(getConfig().previewBaseUrl, env) } : {}),
    });
  }),
);

feedbackRouter.post(
  ROUTE,
  (req, res, next) =>
    json(req, res, (err?: unknown) => {
      if (err) {
        sendJson(res, { ok: false, code: "invalid", error: "Send the comment as JSON." }, 400);
        return;
      }
      next();
    }),
  asyncHandler(async (req, res) => {
    const env = await previewFromUrl(req, res);
    if (!env) return;
    if (!access(req, res, env)) return;
    const parsed = parseFeedback(req.body);
    if (!parsed.ok) {
      sendJson(res, { ok: false, code: "invalid", error: parsed.error }, 400);
      return;
    }
    if (!allowedNow(env.id)) {
      sendJson(res, { ok: false, code: "busy", error: "Lots of comments just now. Wait a few minutes and try again." }, 429);
      return;
    }
    const result = await addFeedback(env.id, parsed.input);
    if (!result.ok) {
      sendJson(res, { ok: false, code: result.code, error: result.error }, result.code === "not_found" ? 404 : 409);
      return;
    }
    sendJson(res, { ok: true, item: result.item });
  }),
);

feedbackRouter.delete(
  `${ROUTE}/:id`,
  asyncHandler(async (req, res) => {
    const env = await previewFromUrl(req, res);
    if (!env) return;
    const denied = checkAdmin({ method: req.method, header: headerOf(req) });
    if (denied) {
      sendJson(res, denied.body, denied.status);
      return;
    }
    const removed = await deleteFeedback(env.id, param(req.params.id).slice(0, 40));
    if (!removed) {
      sendJson(res, { ok: false, code: "not_found", error: "That comment is already gone." }, 404);
      return;
    }
    sendJson(res, { ok: true });
  }),
);
