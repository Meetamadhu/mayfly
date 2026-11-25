/**
 * Backups from the command line, for when Mayfly is stopped.
 *
 *   node dist/restore.js list              newest first
 *   node dist/restore.js now               take a backup now
 *   node dist/restore.js show <name>       what a backup contains, without changing anything
 *   node dist/restore.js restore <name> --yes
 *
 * On a server, use deploy/aws/backup.sh, which stops and starts Mayfly around a restore.
 */
import { createBackup, listBackups, readBackup, restoreBackup } from "@/lib/backup";

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function mayflyIsRunning() {
  const port = Number(process.env.PORT) || 3000;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.status === 200 || response.status === 503;
  } catch {
    return false;
  }
}

async function main() {
  const [command, name, flag] = process.argv.slice(2);

  if (!command || command === "list") {
    const backups = await listBackups();
    if (backups.length === 0) {
      console.log("No backups yet. Mayfly takes the first one within a few minutes of starting.");
      return;
    }
    for (const item of backups) {
      console.log(`${item.name}  ${kb(item.bytes)}${item.beforeRestore ? "  (taken just before a restore)" : ""}`);
    }
    return;
  }

  if (command === "now") {
    const result = await createBackup();
    console.log(`Saved ${result.name} (${result.environments} preview record(s), ${kb(result.bytes)}).`);
    return;
  }

  if (command === "show" || command === "restore") {
    if (!name) throw new Error(`Say which backup: node dist/restore.js ${command} <name>. See the names with "list".`);
    const state = await readBackup(name);
    const live = state.environments.filter((env) => env.status !== "destroyed").length;
    console.log(`${name}`);
    console.log(`  ${state.environments.length} preview record(s), ${live} not removed`);
    console.log(`  lifetime rules: ${state.policy ? "saved" : "server defaults"}`);
    console.log(`  usage month: ${state.usage?.month ?? "none"}`);
    console.log(`  preview settings: ${Object.keys(state.previewSettings ?? {}).length} repositories (values stay encrypted)`);
    if (command === "show") return;

    if (flag !== "--yes") {
      console.log('\nNothing changed. Add --yes to replace the current saved state with this backup.');
      return;
    }
    if (await mayflyIsRunning()) {
      throw new Error("Mayfly is running. Stop it first, or it would overwrite the restored state.");
    }
    const result = await restoreBackup(name);
    console.log(`\nRestored ${result.restored}.`);
    console.log(`What was there before is saved as ${result.previous}, so this can be undone the same way.`);
    return;
  }

  throw new Error(`Unknown command "${command}". Use list, now, show <name> or restore <name> --yes.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
