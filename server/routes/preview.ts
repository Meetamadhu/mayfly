import { Router } from "express";
import { proxyPreview } from "@/lib/preview-proxy";
import { asyncHandler } from "../lib/respond";

export const previewRouter = Router();

// No body parser — the proxy streams the raw request to the preview app.
previewRouter.all("/p/:owner/:name/:pr", asyncHandler(proxyPreview));
previewRouter.all("/p/:owner/:name/:pr/*rest", asyncHandler(proxyPreview));
