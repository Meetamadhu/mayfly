import { Router } from "express";
import { checkAdmin } from "@/lib/admin";

/**
 * GET /back: where a preview's own "Back" link should point. Mayfly sends a signed-in admin to Admin and everyone
 * else to the board, without the intro (from=preview). A preview can't tell who is looking (it's sandboxed and never
 * sees Mayfly's sign-in), but the click is a normal page load that carries the sign-in cookie, so Mayfly can.
 */
export const backRouter = Router();

backRouter.get("/back", (req, res) => {
  const header = (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
  const admin = checkAdmin({ method: "GET", header }) === null;
  res.set("cache-control", "no-store");
  res.redirect(302, admin ? "/admin?from=preview" : "/board?from=preview");
});
