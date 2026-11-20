/**
 * Daily backups: names, keeping the newest, refusing bad or damaged files, restore with its safety copy, the
 * once-a-day timing, and the alert when backups fail. Run with: npx tsx scripts/test-backups.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const work = mkdtempSync(path.join(tmpdir(), "mayfly-backups-"));
process.chdir(work);
delete process.env.MONGODB_URI;
delete process.env.BACKUP_KEEP;
process.env.PREVIEW_BASE_URL = "https://mayfly.test";

async function main() {
  const backup = await import("../src/lib/backup");
  const store = await import("../src/lib/store");
  const alerts = await import("../src/lib/alerts");
  let passed = 0;
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      console.error(`FAILED: ${name}`);
      throw error;
    }
  };

  const env = (id: string, status = "ready") =>
    ({ id, repository: "acme/web", prNumber: Number(id.replace(/\D/g, "")) || 1, status }) as never;

  await check("names round-trip to the time they were taken", () => {
    const at = new Date("2026-11-20T10:04:05.678Z");
    const name = backup.backupName(at);
    assert.equal(name, "mayfly-state-2026-11-20T10-04-05Z.json.gz");
    assert.equal(backup.backupTime(name), Date.parse("2026-11-20T10:04:05Z"));
    assert.equal(backup.backupName(at, true), "mayfly-state-2026-11-20T10-04-05Z-before-restore.json.gz");
  });
  await check("anything that isn't a backup name is refused, including paths", () => {
    for (const bad of ["../state.json", "state.json", "mayfly-state-x.json.gz", "a/mayfly-state-2026-11-20T10-04-05Z.json.gz", ""]) {
      assert.equal(backup.isBackupName(bad), false, bad);
    }
  });
  await check("keep defaults to 7 and ignores nonsense", () => {
    assert.equal(backup.backupKeep(undefined), 7);
    assert.equal(backup.backupKeep("0"), 7);
    assert.equal(backup.backupKeep("2.5"), 7);
    assert.equal(backup.backupKeep("91"), 7);
    assert.equal(backup.backupKeep("30"), 30);
  });

  await store.saveState({ environments: [env("p1"), env("p2", "destroyed")] });

  await check("a backup holds the saved state, readable only by its owner", async () => {
    const made = await backup.createBackup({ now: new Date("2026-11-01T00:00:00Z") });
    assert.equal(made.environments, 2);
    const file = path.join(backup.backupDir(), made.name);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const inside = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    assert.deepEqual(
      inside.environments.map((e: { id: string }) => e.id),
      ["p1", "p2"],
    );
  });

  await check("the newest 7 daily backups are kept", async () => {
    for (let day = 2; day <= 10; day += 1) {
      await backup.createBackup({ now: new Date(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`) });
    }
    const list = await backup.listBackups();
    assert.equal(list.length, 7);
    assert.equal(list[0].takenAt, "2026-11-10T00:00:00.000Z", "newest first");
    assert.equal(list[6].takenAt, "2026-11-04T00:00:00.000Z");
  });

  await check("files that aren't backups in the folder are left alone and not listed", async () => {
    writeFileSync(path.join(backup.backupDir(), "notes.txt"), "mine");
    assert.equal((await backup.listBackups()).length, 7);
    await backup.pruneBackups(1);
    assert.equal(readFileSync(path.join(backup.backupDir(), "notes.txt"), "utf8"), "mine");
    assert.equal((await backup.listBackups()).length, 1);
  });

  const kept = (await backup.listBackups())[0].name;

  await check("a missing, damaged or wrong file is refused with a plain message", async () => {
    await assert.rejects(backup.readBackup("../state.json"), /isn't a Mayfly backup name/);
    await assert.rejects(backup.readBackup("mayfly-state-2020-01-01T00-00-00Z.json.gz"), /no backup called/);
    const damaged = "mayfly-state-2020-01-02T00-00-00Z.json.gz";
    writeFileSync(path.join(backup.backupDir(), damaged), "not gzip");
    await assert.rejects(backup.readBackup(damaged), /damaged/);
    const wrong = "mayfly-state-2020-01-03T00-00-00Z.json.gz";
    const { gzipSync } = await import("node:zlib");
    writeFileSync(path.join(backup.backupDir(), wrong), gzipSync('{"hello":1}'));
    await assert.rejects(backup.readBackup(wrong), /doesn't contain Mayfly's saved state/);
    rmSync(path.join(backup.backupDir(), damaged));
    rmSync(path.join(backup.backupDir(), wrong));
  });

  await check("the download helper refuses names outside the folder", async () => {
    assert.equal(await backup.backupFile("../state.json"), null);
    assert.ok((await backup.backupFile(kept))?.length);
  });

  await check("restore puts the backup back and keeps a copy of what was there", async () => {
    await store.saveState({ environments: [env("changed9")] });
    const result = await backup.restoreBackup(kept);
    assert.equal(result.environments, 2);
    assert.deepEqual(
      (await store.loadState()).environments.map((e) => e.id),
      ["p1", "p2"],
    );
    const before = await backup.readBackup(result.previous);
    assert.deepEqual(
      before.environments.map((e) => e.id),
      ["changed9"],
    );
    assert.ok(result.previous.endsWith("-before-restore.json.gz"));
  });

  await check("restore copies are kept apart and capped at 3", async () => {
    for (let i = 0; i < 4; i += 1) {
      await backup.createBackup({ now: new Date(Date.UTC(2026, 10, 15, 0, 0, i)), beforeRestore: true });
    }
    await backup.pruneBackups(1);
    const list = await backup.listBackups();
    assert.equal(list.filter((b) => b.beforeRestore).length, 3);
    assert.equal(list.filter((b) => !b.beforeRestore).length, 1, "daily backups aren't pushed out");
  });

  // Daily timing and failure alerts.
  const posts: string[] = [];
  const receiver = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      posts.push(JSON.parse(data).text);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/`;
  alerts.resetAlertsForTests();

  rmSync(backup.backupDir(), { recursive: true });
  backup.resetBackupForTests();
  const t0 = Date.parse("2026-12-01T08:00:00Z");

  await check("with no backups, one is taken straight away", async () => {
    assert.ok(await backup.maybeBackup(t0));
    assert.equal((await backup.listBackups()).length, 1);
  });
  await check("it only looks again after 10 minutes", async () => {
    assert.equal(await backup.maybeBackup(t0 + 5 * 60_000), null);
  });
  await check("a backup less than a day old isn't repeated", async () => {
    assert.equal(await backup.maybeBackup(t0 + 23 * 60 * 60_000), null);
    assert.equal((await backup.listBackups()).length, 1);
  });
  await check("after a day, the next one is taken", async () => {
    assert.ok(await backup.maybeBackup(t0 + 24 * 60 * 60_000 + 60_000));
    assert.equal((await backup.listBackups()).length, 2);
  });

  await check("a failing backup alerts once, not on every try", async () => {
    rmSync(backup.backupDir(), { recursive: true });
    writeFileSync(backup.backupDir(), "a file where the folder should be");
    const t1 = t0 + 3 * 24 * 60 * 60_000;
    assert.equal(await backup.maybeBackup(t1), null);
    assert.equal(await backup.maybeBackup(t1 + 11 * 60_000), null);
    assert.equal(posts.filter((p) => p.startsWith("Mayfly: the daily backup failed")).length, 1);
  });
  await check("and says so when backups work again", async () => {
    rmSync(backup.backupDir());
    mkdirSync(backup.backupDir());
    assert.ok(await backup.maybeBackup(t0 + 3 * 24 * 60 * 60_000 + 30 * 60_000));
    assert.equal(posts.filter((p) => p.startsWith("Mayfly: backups are working again")).length, 1);
  });
  receiver.close();

  console.log(`${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
