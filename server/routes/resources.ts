import { Router } from "express";
import { checkAdmin } from "@/lib/admin";
import { getDeployer } from "@/lib/deployer";
import { memoryAlertPercent, previewResources, serverResources } from "@/lib/resources";
import { asyncHandler, sendJson } from "../lib/respond";

export const resourcesRouter = Router();

/**
 * CPU and memory. Everyone gets the per-preview numbers shown on the board's cards (keyed by deployment id; null
 * when there's nothing to measure, e.g. simulated previews). Signed-in admins also get the server's own numbers.
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

    const deployments = await getDeployer().list();
    const [byDeployment, server] = await Promise.all([
      previewResources(deployments),
      admin ? serverResources() : Promise.resolve(undefined),
    ]);
    const previews = byDeployment ? Object.fromEntries(byDeployment) : null;
    sendJson(res, {
      ok: true,
      previews,
      ...(server ? { server: { ...server, alertPercent: memoryAlertPercent() } } : {}),
    });
  }),
);
