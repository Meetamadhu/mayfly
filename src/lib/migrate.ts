import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { backupDir, backupFile, createBackup, isBackupName, listBackups, restoreBackup } from "./backup";

/**
 * Moving Mayfly to a new server: pack a backup (and a checklist) on the old host, copy the folder, restore on the
 * new host while Mayfly is stopped. Secrets stay in .env.local and are never packed — you copy that file yourself.
 */

export interface PackResult {
  dir: string;
  backup: string;
  checklist: string;
  bytes: number;
  environments: number;
}

const CHECKLIST = `# Moving Mayfly to a new server

1. On the old server, with Mayfly running or stopped:
     node dist/restore.js pack
   That writes a folder under data/migrate/ with a backup and this file.

2. Copy that folder to the new server (scp, rsync, …). Also copy .env.local yourself — it is never packed,
   because it holds tokens and passwords.

3. On the new server: install Mayfly the usual way (deploy/aws/setup.sh, or npm ci && npm run build), put
   .env.local in place, and make sure Mayfly is STOPPED.

4. Restore:
     node dist/restore.js restore <backup-name> --yes
   Or, from the packed folder:
     node dist/restore.js apply <path-to-packed-folder> --yes

5. Start Mayfly. Open /api/health — it should answer 200 or 503. Sign in and check Previews.

Notes
- Preview containers are not moved. After a restore on a new Docker host, open pull requests rebuild on the
  next push (or remove and re-open the preview).
- If several Mayfly hosts share one MongoDB, restore only on the host whose PREVIEW_REPOS you are moving.
`;

/** Write a migrate folder with a fresh backup and a checklist. */
export async function packMigrate(options: { now?: Date; outDir?: string } = {}): Promise<PackResult> {
  const backup = await createBackup({ now: options.now });
  const stamp = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const dir = options.outDir ?? path.join(backupDir(), "..", "migrate", `mayfly-migrate-${stamp}`);
  await mkdir(dir, { recursive: true });
  const source = path.join(backupDir(), backup.name);
  const target = path.join(dir, backup.name);
  await copyFile(source, target);
  const checklist = path.join(dir, "README.txt");
  await writeFile(checklist, CHECKLIST, "utf8");
  const raw = await backupFile(backup.name);
  return {
    dir,
    backup: backup.name,
    checklist,
    bytes: raw?.byteLength ?? backup.bytes,
    environments: backup.environments,
  };
}

/** Restore from a packed migrate folder (the .json.gz inside it). */
export async function applyMigratePack(dir: string) {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(dir);
  const backup = names.find((name) => isBackupName(name) && !name.includes("-before-restore"));
  if (!backup) throw new Error(`No Mayfly backup (.json.gz) found in ${dir}.`);
  // Copy into the live backups folder so restoreBackup can find it by name.
  await mkdir(backupDir(), { recursive: true });
  await copyFile(path.join(dir, backup), path.join(backupDir(), backup));
  return restoreBackup(backup);
}

/** The newest daily backup name, for scripts that want a default. */
export async function newestBackupName() {
  const item = (await listBackups()).find((backup) => !backup.beforeRestore);
  return item?.name ?? null;
}
