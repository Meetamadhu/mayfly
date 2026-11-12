import express, { type NextFunction, type Request, type Response } from "express";
import type { LifecycleResult } from "@/lib/types";

export function sendJson(res: Response, body: unknown, status = 200) {
  res.status(status).set("Cache-Control", "no-store").json(body);
}

export function sendLifecycle(res: Response, result: LifecycleResult) {
  if (result.ok) {
    sendJson(res, result);
    return;
  }
  const status = {
    invalid: 400,
    not_found: 404,
    cap: 409,
    conflict: 409,
    deploy_failed: 502,
  }[result.code];
  sendJson(res, result, status);
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

/** Invalid JSON becomes an empty body so sign-in treats it as a wrong/empty token (401), not 400. */
export function softJson(limit = "16kb") {
  const parser = express.json({ limit });
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (err?: unknown) => {
      if (err) {
        req.body = {};
        next();
        return;
      }
      next();
    });
  };
}
