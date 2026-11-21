import { Router } from "express";
import { assetLinks } from "@/lib/asset-links";

export const wellKnownRouter = Router();

/** For the Android app: see src/lib/asset-links.ts. */
wellKnownRouter.get("/.well-known/assetlinks.json", (_req, res) => {
  const links = assetLinks();
  if (!links) {
    res.status(404).type("application/json").send("[]");
    return;
  }
  res.status(200).set({ "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }).send(JSON.stringify(links));
});
