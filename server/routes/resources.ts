import { Router } from "express";
import { checkAdmin } from "@/lib/admin";
import { getDeployer } from "@/lib/deployer";
import {
  memoryAlertPercent,
  previewContainerName,
  previewResources,
  serverResources,
  type PreviewResources,
} from "@/lib/resources";
import { asyncHandler, sendJson } from "../lib/respond";

export const resourcesRouter = Router();

/**
 * CPU and memory. Everyone gets the per-preview numbers shown on the board's cards (keyed by deployment id; null
 * when previews don't run in Docker). Signed-in admins also get the server's own numbers for the Admin page.
 */
resourcesRouter.get(
  "/api/resources",
  asyncHandler(async (req, res) => {
    const header = (name: string): string | null => {
      const value = req.headers[name.toLowerCase()];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    };
    const admin = checkAdmin({ method: req.method, header }) === null;

    const [byContainer, deployments, server] = await Promise.all([
      previewResources(),
      getDeployer().list(),
      admin ? serverResources() : Promise.resolve(undefined),
    ]);

    let previews: Record<string, PreviewResources> | null = null;
    if (byContainer) {
      previews = {};
      for (const deployment of deployments) {
        if (typeof deployment.port !== "number") continue;
        const usage = byContainer.get(previewContainerName(deployment.port));
        if (usage) previews[deployment.deploymentId] = usage;
      }
    }
    sendJson(res, { ok: true, previews, ...(server ? { server: { ...server, alertPercent: memoryAlertPercent() } } : {}) });
  }),
);
