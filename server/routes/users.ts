import { Router, type Request } from "express";
import { delayWrongSignIn } from "@/lib/admin";
import { headerOf, requireMember, whoIs } from "@/lib/access";
import { clearEvents, countEvent, isLimited } from "@/lib/rate-limit";
import {
  USER_SESSION_SECONDS,
  changeUser,
  listAudit,
  listUsers,
  recordAudit,
  signInUser,
  signUp,
  userCookie,
  type UserAction,
} from "@/lib/users";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson, softJson } from "../lib/respond";

export const usersRouter = Router();

const MINUTE = 60 * 1000;

function clientIp(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function field(req: Request, name: string) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return body[name];
}

/** Who's signed in, for the top bar and the pages: { role: "admin" | "user" | null, name }. */
usersRouter.get(
  "/api/session",
  asyncHandler(async (req, res) => {
    const actor = await whoIs({ method: "GET", header: headerOf(req) });
    sendJson(res, { ok: true, role: actor?.role ?? null, name: actor?.name ?? null });
  }),
);

usersRouter.post(
  "/api/users/signup",
  softJson("16kb"),
  asyncHandler(async (req, res) => {
    const ipKey = `signup:${clientIp(req)}`;
    if (isLimited(ipKey, 5, 60 * MINUTE)) {
      sendJson(res, { ok: false, code: "rate_limited", error: "Too many sign-ups from here. Try again in an hour." }, 429);
      return;
    }
    const result = await signUp(field(req, "username"), field(req, "password"));
    if (!result.ok) {
      if (result.code !== "invalid") countEvent(ipKey);
      const status = result.code === "invalid" ? 400 : result.code === "taken" ? 409 : 429;
      sendJson(res, result, status);
      return;
    }
    countEvent(ipKey);
    sendJson(res, { ok: true, status: "pending", username: result.user.username });
  }),
);

usersRouter.post(
  "/api/users/session",
  softJson("16kb"),
  asyncHandler(async (req, res) => {
    const username = String(field(req, "username") ?? "").trim().toLowerCase().slice(0, 40);
    const ipKey = `signin-ip:${clientIp(req)}`;
    const nameKey = `signin-user:${username}`;
    if (isLimited(ipKey, 20, 15 * MINUTE) || isLimited(nameKey, 8, 15 * MINUTE)) {
      sendJson(res, { ok: false, code: "rate_limited", error: "Too many wrong tries. Wait 15 minutes and try again." }, 429);
      return;
    }
    const result = await signInUser(field(req, "username"), field(req, "password"));
    if (!result.ok) {
      if (result.code === "wrong") {
        countEvent(ipKey);
        countEvent(nameKey);
        await delayWrongSignIn();
      }
      sendJson(res, result, result.code === "wrong" ? 401 : 403);
      return;
    }
    clearEvents(nameKey);
    res.set("Set-Cookie", userCookie(result.cookie, USER_SESSION_SECONDS));
    await recordAudit({ name: result.user.username, role: "user" }, "signin");
    sendJson(res, { ok: true, username: result.user.username });
  }),
);

usersRouter.delete("/api/users/session", (_req, res) => {
  res.set("Set-Cookie", userCookie("", 0));
  sendJson(res, { ok: true });
});

usersRouter.get(
  "/api/admin/users",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, { ok: true, users: await listUsers() });
  }),
);

const ACTIONS: UserAction[] = ["approve", "disable", "enable", "remove", "signout"];

usersRouter.post(
  "/api/admin/users/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const action = String(req.query.action ?? "") as UserAction;
    if (!ACTIONS.includes(action)) {
      sendJson(res, { ok: false, code: "invalid", error: "Unknown action." }, 400);
      return;
    }
    const id = String(req.params.id ?? "");
    const before = (await listUsers()).find((user) => user.id === id);
    const result = await changeUser(id, action);
    if (!result.ok) {
      sendJson(res, result, result.code === "not_found" ? 404 : 400);
      return;
    }
    await recordAudit({ name: "admin", role: "admin" }, `user.${action}`, before?.username ?? null);
    sendJson(res, result);
  }),
);

/** The activity log, for anyone signed in. */
usersRouter.get(
  "/api/audit",
  asyncHandler(async (req, res) => {
    const access = await requireMember({ method: "GET", header: headerOf(req) });
    if (!("actor" in access)) {
      sendJson(res, access.body, access.status);
      return;
    }
    sendJson(res, { ok: true, entries: await listAudit(100) });
  }),
);
