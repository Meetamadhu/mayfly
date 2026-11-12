import { Router } from "express";
import { delayWrongSignIn, sessionCookie, SESSION_MAX_AGE, signIn } from "@/lib/admin";
import { asyncHandler, sendJson, softJson } from "../lib/respond";

export const adminRouter = Router();

adminRouter.post(
  "/api/admin/session",
  softJson("16kb"),
  asyncHandler(async (req, res) => {
    const raw = req.body && typeof req.body === "object" ? (req.body as { token?: unknown }).token : "";
    const token = typeof raw === "string" ? raw : "";
    const value = signIn(token);
    if (!value) {
      await delayWrongSignIn();
      sendJson(res, { ok: false, code: "unauthorized", error: "Wrong token." }, 401);
      return;
    }
    res.set("Set-Cookie", sessionCookie(value, SESSION_MAX_AGE));
    sendJson(res, { ok: true });
  }),
);

adminRouter.delete("/api/admin/session", (_req, res) => {
  res.set("Set-Cookie", sessionCookie("", 0));
  sendJson(res, { ok: true });
});
