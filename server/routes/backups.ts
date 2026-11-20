import { Router } from "express";
import { backupFile, backupKeep, createBackup, isBackupName, listBackups } from "@/lib/backup";
import { requireAdmin } from "../middleware/require-admin";
import { asyncHandler, sendJson } from "../lib/respond";

export const backupsRouter = Router();

/** Admins only. Restoring is deliberately not here: it needs Mayfly stopped, so it's deploy/aws/backup.sh. */
backupsRouter.get(
  "/api/admin/backups",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    sendJson(res, { ok: true, keep: backupKeep(), backups: await listBackups() });
  }),
);

backupsRouter.post(
  "/api/admin/backups",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const backup = await createBackup();
    sendJson(res, { ok: true, backup });
  }),
);

backupsRouter.get(
  "/api/admin/backups/:name",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = String(req.params.name ?? "");
    const file = isBackupName(name) ? await backupFile(name) : null;
    if (!file) {
      sendJson(res, { ok: false, code: "not_found", error: "No backup with that name." }, 404);
      return;
    }
    res
      .status(200)
      .set({
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(file);
  }),
);
