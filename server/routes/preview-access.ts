import express, { Router } from "express";
import { delayWrongSignIn } from "@/lib/admin";
import {
  accessCookie,
  accessDays,
  issueAccessValue,
  passwordMatches,
  passwordPage,
  previewPassword,
  recordWrongTry,
  safeNext,
  tooManyTries,
} from "@/lib/preview-access";
import { asyncHandler } from "../lib/respond";

export const previewAccessRouter = Router();

/** The form on a private preview's password page posts here; a right password sets the cookie and goes back. */
previewAccessRouter.post(
  "/api/preview-access",
  express.urlencoded({ extended: false, limit: "4kb" }),
  asyncHandler(async (req, res) => {
    const next = safeNext(req.body?.next);
    const match = next ? /^\/p\/([^/]+)\/([^/]+)\/(\d+)/.exec(next) : null;
    let repository = "this repository";
    if (match) {
      try {
        repository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
      } catch {
        // Keep the generic wording.
      }
    }
    const pr = match?.[3] ?? "?";
    const page = (status: number, error: string) => {
      res.status(status);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(passwordPage({ repository, pr, next: next ?? "/board", error }));
    };

    const password = previewPassword();
    if (!password || !next) {
      res.redirect(303, next ?? "/board");
      return;
    }
    const address = req.ip ?? "unknown";
    if (tooManyTries(address)) {
      page(429, "Too many wrong tries. Wait 15 minutes and try again.");
      return;
    }
    const given = typeof req.body?.password === "string" ? req.body.password : "";
    if (!passwordMatches(given, password)) {
      recordWrongTry(address);
      await delayWrongSignIn();
      page(401, "That password didn't work. Check it and try again.");
      return;
    }
    const days = accessDays();
    res.setHeader("Set-Cookie", accessCookie(issueAccessValue(password, Date.now(), days), days * 24 * 60 * 60));
    res.redirect(303, next);
  }),
);
