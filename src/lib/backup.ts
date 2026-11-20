import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Watch, sendAlert } from "./alerts";
import { asState, dataDir, loadState, saveState, type State } from "./store";

/**
 * Daily backups of Mayfly's saved state: every preview record, the month's usage and the lifetime rules.
 * Works the same with the JSON file and with MongoDB, because it goes through loadState/saveState.
 *
 * Backups are gzip files in data/backups, one a day, newest BACKUP_KEEP kept (default 7). They live on the same
 * disk as Mayfly, so they protect against a bad change or a bug wiping data, not against losing the server: for
 * that, download one from the admin page or snapshot the disk (deploy/aws/README.md).
 *
 * The state holds no tokens (those stay in .env.local): preview records, settings, the activity log and team
 * accounts, whose passwords are stored only as scrypt hashes. Still, treat backup files as private.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^mayfly-state-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(-before-restore)?\.json\.gz$/;

export function backupDir() {
  return path.join(dataDir(), "backups");
}

/** How many backups to keep. 1 to 90, default 7. */
export function backupKeep(raw = process.env.BACKUP_KEEP) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : 7;
}

export function isBackupName(name: string) {
  return NAME.test(name);
}

export function backupName(at: Date, beforeRestore = false) {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `mayfly-state-${stamp}${beforeRestore ? "-before-restore" : ""}.json.gz`;
}

/** When a backup was taken, from its name. */
export function backupTime(name: string): number | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface BackupInfo {
  name: string;
  takenAt: string;
  bytes: number;
  beforeRestore: boolean;
}

/** Newest first. Files that aren't Mayfly backups are ignored. */
export async function listBackups(): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(backupDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const at = backupTime(name);
    if (at === null) continue;
    const info = await stat(path.join(backupDir(), name)).catch(() => null);
    if (!info?.isFile()) continue;
    out.push({
      name,
      takenAt: new Date(at).toISOString(),
      bytes: info.size,
      beforeRestore: name.includes("-before-restore"),
    });
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.name.localeCompare(a.name));
}

/** Save the current state as a new backup and drop the oldest beyond BACKUP_KEEP. */
export async function createBackup(options: { now?: Date; beforeRestore?: boolean } = {}) {
  const now = options.now ?? new Date();
  const state = await loadState();
  const body = gzipSync(Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  await mkdir(backupDir(), { recursive: true, mode: 0o700 });
  const name = backupName(now, options.beforeRestore);
  const file = path.join(backupDir(), name);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, file);
  const removed = await pruneBackups(backupKeep());
  return { name, bytes: body.length, environments: state.environments.length, removed };
}

/**
 * Keep the newest `keep` daily backups. Backups taken just before a restore are kept apart (newest 3), so a
 * few restores in a row can't push out the daily ones, and the copy of what was there before stays available.
 */
export async function pruneBackups(keep: number) {
  const all = await listBackups();
  const daily = all.filter((item) => !item.beforeRestore);
  const restore = all.filter((item) => item.beforeRestore);
  const drop = [...daily.slice(keep), ...restore.slice(3)];
  for (const item of drop) await unlink(path.join(backupDir(), item.name)).catch(() => {});
  return drop.length;
}

/** Read and check a backup. Throws with a plain message when the name or the contents are wrong. */
export async function readBackup(name: string): Promise<State> {
  if (!isBackupName(name)) throw new Error(`"${name}" isn't a Mayfly backup name.`);
  let raw: Buffer;
  try {
    raw = await readFile(path.join(backupDir(), name));
  } catch {
    throw new Error(`There's no backup called ${name}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(raw).toString("utf8"));
  } catch {
    throw new Error(`${name} is damaged and can't be read.`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as State).environments)) {
    throw new Error(`${name} doesn't contain Mayfly's saved state.`);
  }
  return asState(parsed);
}

/** The raw file, for the admin download. Name is checked, so no path can escape the backups folder. */
export async function backupFile(name: string): Promise<Buffer | null> {
  if (!isBackupName(name)) return null;
  return readFile(path.join(backupDir(), name)).catch(() => null);
}

/**
 * Replace the saved state with a backup. Takes a "before restore" backup of the current state first, so a
 * restore can itself be undone. Only run this while Mayfly is stopped (deploy/aws/backup.sh does that).
 */
export async function restoreBackup(name: string) {
  const state = await readBackup(name);
  const safety = await createBackup({ beforeRestore: true });
  await saveState(state);
  return { restored: name, environments: state.environments.length, previous: safety.name };
}

type BackupMemory = { watch: Watch; lastCheck: number };
function memory(): BackupMemory {
  const holder = globalThis as unknown as { __mayflyBackup?: BackupMemory };
  holder.__mayflyBackup ??= { watch: new Watch(1), lastCheck: 0 };
  return holder.__mayflyBackup;
}

/**
 * Called by the reaper loop. Takes a backup when the newest daily one is a day old (or there is none), at most
 * one attempt every 10 minutes. Alerts once if it fails and once when it works again.
 */
export async function maybeBackup(now = Date.now()) {
  const mem = memory();
  if (now - mem.lastCheck < 10 * 60 * 1000) return null;
  mem.lastCheck = now;
  try {
    const newest = (await listBackups()).find((item) => !item.beforeRestore);
    if (newest && now - Date.parse(newest.takenAt) < DAY_MS) return null;
    const result = await createBackup({ now: new Date(now) });
    console.log(`Backup saved: ${result.name} (${result.environments} preview record(s)).`);
    if (mem.watch.update(true) === "up") {
      await sendAlert("backup-ok", "backups are working again", [result.name], { repeatAfterMs: 0 });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Backup failed", error);
    if (mem.watch.update(false) === "down") {
      await sendAlert("backup-failed", "the daily backup failed", [
        message,
        "Mayfly keeps running, but no new backup is being saved. Check disk space and the server log.",
      ]);
    }
    return null;
  }
}

/** Tests only. */
export function resetBackupForTests() {
  const holder = globalThis as unknown as { __mayflyBackup?: BackupMemory };
  delete holder.__mayflyBackup;
}
