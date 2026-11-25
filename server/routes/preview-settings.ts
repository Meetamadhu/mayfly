import express, { Router, type Request, type Response } from "express";
import { getConfig, previewRepos, previewRuntime } from "@/lib/config";
import { applySettingsUpdate, secretsKeyConfigured, settingsView } from "@/lib/preview-settings";
import { exclusive, loadState, saveState } from "@/lib/store";
import { isLiveStatus } from "@/lib/types";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

/**
 * Preview settings, admins only. Values go in and are never sent back out: the page sees names and dates.
 *   GET    /api/preview-settings                  every repository's settings, and repositories to choose from
 *   PUT    /api/preview-settings/:owner/:name     save one repository's size and variables
 *   DELETE /api/preview-settings/:owner/:name     clear them
 */
export const previewSettingsRouter = Router();

const json = express.json({ limit: "512kb" });

function repositoryFrom(req: Request, res: Response) {
  const value = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw) ?? "";
  let repository = "";
  try {
    repository = `${decodeURIComponent(value(req.params.owner))}/${decodeURIComponent(value(req.params.name))}`.toLowerCase();
  } catch {
    repository = "";
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.length > 200) {
    sendJson(res, { ok: false, code: "invalid", error: "That isn't a repository name (owner/name)." }, 400);
    return null;
  }
  return repository;
}

async function overview() {
  const state = await loadState();
  const saved = state.previewSettings ?? {};
  const live = new Map<string, number>();
  const known = new Set<string>(previewRepos());
  for (const env of state.environments) {
    known.add(env.repository);
    if (isLiveStatus(env.status)) live.set(env.repository, (live.get(env.repository) ?? 0) + 1);
  }
  for (const repository of Object.keys(saved)) known.add(repository);
  const repositories = [...known].sort();
  return {
    ok: true,
    keyConfigured: secretsKeyConfigured(),
    githubConnected: Boolean(getConfig().githubToken),
    runtime: previewRuntime(),
    allowed: previewRepos(),
    repositories,
    settings: Object.keys(saved)
      .sort()
      .map((repository) => ({ ...settingsView(repository, saved[repository]), livePreviews: live.get(repository) ?? 0 })),
  };
}

previewSettingsRouter.get(
  "/api/preview-settings",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, await overview());
  }),
);

previewSettingsRouter.put(
  "/api/preview-settings/:owner/:name",
  requireAdmin,
  (req, res, next) =>
    json(req, res, (err?: unknown) => {
      if (err) {
        sendJson(res, { ok: false, code: "invalid", error: "Send the settings as JSON (512 KB at most)." }, 400);
        return;
      }
      next();
    }),
  asyncHandler(async (req, res) => {
    const repository = repositoryFrom(req, res);
    if (!repository) return;
    const result = await exclusive(async () => {
      const state = await loadState();
      const applied = applySettingsUpdate(req.body, state.previewSettings?.[repository]);
      if (!applied.ok) return applied;
      state.previewSettings = { ...(state.previewSettings ?? {}), [repository]: applied.settings };
      await saveState(state);
      return applied;
    });
    if (!result.ok) {
      sendJson(res, { ok: false, code: "invalid", error: result.error }, 400);
      return;
    }
    sendJson(res, await overview());
  }),
);

previewSettingsRouter.delete(
  "/api/preview-settings/:owner/:name",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const repository = repositoryFrom(req, res);
    if (!repository) return;
    await exclusive(async () => {
      const state = await loadState();
      if (!state.previewSettings?.[repository]) return;
      const { [repository]: _removed, ...rest } = state.previewSettings;
      state.previewSettings = rest;
      await saveState(state);
    });
    sendJson(res, await overview());
  }),
);
