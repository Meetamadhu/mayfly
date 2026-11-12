import type { NextFunction, Request, Response } from "express";
import { checkAdmin } from "@/lib/admin";

function headerOf(req: Request) {
  return (name: string): string | null => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
}

/** Express adapter for checkAdmin. Failure body matches Next's json() helper (Cache-Control: no-store). */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const denied = checkAdmin({ method: req.method, header: headerOf(req) });
  if (!denied) {
    next();
    return;
  }
  res.status(denied.status).set("Cache-Control", "no-store").json(denied.body);
}
