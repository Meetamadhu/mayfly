/**
 * Pack and restore a migrate folder. Run with: npx tsx scripts/test-migrate.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(tmpdir(), "mayfly-migrate-"));
process.chdir(work);
delete process.env.MONGODB_URI;

async function main() {
  const { packMigrate, applyMigratePack } = await import("../src/lib/migrate");
  const store = await import("../src/lib/store");

  await store.saveState({
    environments: [
      {
        id: "e1",
        repository: "acme/web",
        prNumber: 7,
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "feat",
        status: "ready",
        deploymentId: null,
        url: "http://localhost/p/acme/web/7",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-08T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        destroyedAt: null,
        destroyReason: null,
        error: null,
        updateGeneration: 0,
        comments: [],
        events: [{ at: "2026-01-01T00:00:00.000Z", type: "opened" }],
      },
    ],
  });

  const packed = await packMigrate({ outDir: path.join(work, "pack-out") });
  assert.equal(packed.environments, 1);
  const readme = readFileSync(packed.checklist, "utf8");
  assert.ok(readme.includes(".env.local"));
  assert.ok(readme.includes("node dist/restore.js"));

  await store.saveState({ environments: [] });
  assert.equal((await store.loadState()).environments.length, 0);

  const restored = await applyMigratePack(packed.dir);
  assert.equal(restored.restored, packed.backup);
  const after = await store.loadState();
  assert.equal(after.environments.length, 1);
  assert.equal(after.environments[0].repository, "acme/web");
  assert.ok(restored.previous.includes("before-restore"));

  console.log("migrate: ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle briefly.
    }
  });
