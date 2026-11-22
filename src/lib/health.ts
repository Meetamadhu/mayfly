import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { Watch, diskAlertPercent, sendAlert } from "./alerts";
import { getConfig, previewRuntime } from "./config";
import { memoryAlertPercent, serverResources } from "./resources";
import { dataDir, loadState } from "./store";

/**
 * Health: is Mayfly able to do its job right now? Used by GET /api/health (for an uptime monitor) and by the
 * reaper loop, which alerts when Docker or disk space goes wrong and again when they recover.
 */

export type CheckResult = { ok: boolean; detail: string };

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  startedAt: string;
  checks: {
    storage: CheckResult;
    disk: CheckResult & { freePercent: number | null };
    docker: CheckResult;
    reaper: CheckResult;
  };
}

type HealthMemory = {
  startedAt: number;
  reaperOkAt: number | null;
  cached: { at: number; report: HealthReport } | null;
  disk: Watch;
  docker: Watch;
  reaper: Watch;
  memory: Watch;
};

function memory(): HealthMemory {
  const holder = globalThis as unknown as { __mayflyHealth?: HealthMemory };
  holder.__mayflyHealth ??= {
    startedAt: Date.now(),
    reaperOkAt: null,
    cached: null,
    disk: new Watch(1),
    // A single slow answer from Docker isn't worth a message; two checks in a row is.
    docker: new Watch(2),
    reaper: new Watch(1),
    // Memory spikes during a build; only a reading that stays high for three rounds in a row is worth a message.
    memory: new Watch(3),
  };
  return holder.__mayflyHealth;
}

export function markReaperOk(now = Date.now()) {
  memory().reaperOkAt = now;
}

async function storageCheck(): Promise<CheckResult> {
  try {
    await loadState();
    return { ok: true, detail: "Saved state can be read." };
  } catch (error) {
    return { ok: false, detail: `Can't read saved state: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Free space on the disk that holds Mayfly's data (and, on one server, the Docker images). */
export function diskResult(freePercent: number | null, threshold: number, wasDown: boolean) {
  if (freePercent === null) return { ok: true, freePercent, detail: "Disk space couldn't be read here." };
  // Once below the line, wait for 5 points of headroom before calling it fine, so it doesn't flap.
  const line = wasDown ? threshold + 5 : threshold;
  const ok = freePercent >= line;
  return {
    ok,
    freePercent,
    detail: `${freePercent.toFixed(1)}% free${ok ? "" : ` (alert below ${threshold}%)`}.`,
  };
}

async function diskCheck(): Promise<CheckResult & { freePercent: number | null }> {
  const dir = existsSync(dataDir()) ? dataDir() : process.cwd();
  let freePercent: number | null = null;
  try {
    const stats = await statfs(dir);
    if (stats.blocks > 0) freePercent = (stats.bavail / stats.blocks) * 100;
  } catch {
    freePercent = null;
  }
  return diskResult(freePercent, diskAlertPercent(), memory().disk.isDown);
}

function usesDocker() {
  return previewRuntime() === "docker" && getConfig().deployer !== "fake";
}

function dockerCheck(): Promise<CheckResult> {
  if (!usesDocker()) return Promise.resolve({ ok: true, detail: "Not used (previews run as plain processes)." });
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) resolve({ ok: false, detail: "Docker isn't answering, so previews can't be built or started." });
        else resolve({ ok: true, detail: `Docker ${stdout.trim() || "is answering"}.` });
      },
    );
  });
}

export function reaperResult(reaperOkAt: number | null, startedAt: number, intervalMs: number, now: number): CheckResult {
  // Allow three missed rounds (and a two-minute start-up grace) before calling the clean-up loop stuck.
  const allowedMs = Math.max(3 * intervalMs, 120_000);
  const since = reaperOkAt ?? startedAt;
  if (now - since <= allowedMs) {
    return { ok: true, detail: reaperOkAt ? "Clean-up loop is running." : "Clean-up loop is starting." };
  }
  return { ok: false, detail: "The clean-up loop hasn't finished a round recently, so expired previews may pile up." };
}

/** Run every check. Cached for 15 seconds, so a busy uptime monitor can't make it read the database non-stop. */
export async function checkHealth(options: { fresh?: boolean; now?: number } = {}): Promise<HealthReport> {
  const mem = memory();
  const now = options.now ?? Date.now();
  if (!options.fresh && mem.cached && now - mem.cached.at < 15_000) return mem.cached.report;

  const [storage, disk, docker] = await Promise.all([storageCheck(), diskCheck(), dockerCheck()]);
  const reaper = reaperResult(mem.reaperOkAt, mem.startedAt, getConfig().reaperIntervalMs, now);
  const report: HealthReport = {
    ok: storage.ok && disk.ok && docker.ok && reaper.ok,
    checkedAt: new Date(now).toISOString(),
    startedAt: new Date(mem.startedAt).toISOString(),
    checks: { storage, disk, docker, reaper },
  };
  mem.cached = { at: now, report };
  return report;
}

/** Called by the reaper loop after each round: alert on the way down and on the way back up. */
export async function watchHealth() {
  const mem = memory();
  const report = await checkHealth({ fresh: true });
  const { disk, docker } = report.checks;

  const diskChange = mem.disk.update(disk.ok);
  if (diskChange === "down") {
    await sendAlert("disk-low", "the server is running out of disk space", [
      disk.detail,
      "New builds may fail. Old images are pruned daily; remove unused previews or grow the disk.",
    ]);
  } else if (diskChange === "up") {
    await sendAlert("disk-ok", "disk space is back to normal", [disk.detail], { repeatAfterMs: 0 });
  }

  try {
    const resources = await serverResources();
    const limit = memoryAlertPercent();
    const where = resources.scope === "container" ? "Mayfly's container" : "the server";
    const used = `${where} is using ${resources.memPercent}% of its memory (${gib(resources.memUsedBytes)} of ${gib(resources.memTotalBytes)}).`;
    const memoryChange = mem.memory.update(resources.memPercent < limit);
    if (memoryChange === "down") {
      await sendAlert("memory-high", "the server is running low on memory", [
        used,
        "Previews may be stopped by the system or fail to start. Remove unused previews, lower PREVIEW_MEMORY or use a bigger server.",
      ]);
    } else if (memoryChange === "up") {
      await sendAlert("memory-ok", "memory use is back to normal", [used], { repeatAfterMs: 0 });
    }
  } catch (error) {
    console.error("Memory check failed", error);
  }

  const dockerChange = mem.docker.update(docker.ok);
  if (dockerChange === "down") {
    await sendAlert("docker-down", "Docker isn't answering", [docker.detail]);
  } else if (dockerChange === "up") {
    await sendAlert("docker-up", "Docker is answering again", [docker.detail], { repeatAfterMs: 0 });
  }
}

function gib(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Called by the reaper loop when a whole round throws. */
export async function reaperFailed(error: unknown) {
  if (memory().reaper.update(false) === "down") {
    await sendAlert("reaper-error", "the clean-up loop failed", [
      error instanceof Error ? error.message : String(error),
      "Expired previews aren't being removed until this is fixed. Check the server log.",
    ]);
  }
}

export async function reaperRecovered() {
  if (memory().reaper.update(true) === "up") {
    await sendAlert("reaper-ok", "the clean-up loop is running again", [], { repeatAfterMs: 0 });
  }
}

/** Tests only. */
export function resetHealthForTests() {
  const holder = globalThis as unknown as { __mayflyHealth?: HealthMemory };
  delete holder.__mayflyHealth;
}
