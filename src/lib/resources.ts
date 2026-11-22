import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { getConfig, previewRuntime } from "./config";

/**
 * CPU and memory: for the server Mayfly runs on (Admin page, low-memory alert) and for each running preview
 * container (on its card). Numbers only; nothing here can change anything.
 *
 * Server numbers come from the container's own limits when it has them (cgroup v2, e.g. Render), otherwise from
 * the whole machine (/proc, e.g. the AWS server). Preview numbers come from `docker stats`, which the Docker
 * socket proxy already allows (CONTAINERS=1), so they exist only when previews run in Docker.
 */

export interface ServerResources {
  /** CPU in use, 0-100, across everything this server may use. Null until two readings exist. */
  cpuPercent: number | null;
  /** How many CPUs that 100% stands for (may be fractional for a container limit). */
  cpus: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memPercent: number;
  /** "container" when the numbers are this container's own limit, "server" for the whole machine. */
  scope: "container" | "server";
  checkedAt: string;
}

export interface PreviewResources {
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

const CGROUP = "/sys/fs/cgroup";

async function readText(file: string) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

// ── Memory ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** cgroup v2: the container's limit and what it uses, minus page cache it can drop. Null when there's no limit. */
export function cgroupMemory(maxText: string | null, currentText: string | null, statText: string | null) {
  const max = Number(maxText);
  const current = Number(currentText);
  if (!maxText || maxText === "max" || !Number.isFinite(max) || max <= 0 || !Number.isFinite(current)) return null;
  const inactive = Number(/^inactive_file (\d+)$/m.exec(statText ?? "")?.[1] ?? 0);
  const used = Math.max(0, current - (Number.isFinite(inactive) ? inactive : 0));
  return { used, total: max };
}

/** /proc/meminfo: total minus what the kernel says is available (free plus cache it can drop). */
export function procMemory(meminfo: string | null) {
  const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(meminfo ?? "")?.[1]) * 1024;
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(meminfo ?? "")?.[1]) * 1024;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
  return { used: Math.max(0, total - available), total };
}

async function memoryNow() {
  const container = cgroupMemory(
    await readText(`${CGROUP}/memory.max`),
    await readText(`${CGROUP}/memory.current`),
    await readText(`${CGROUP}/memory.stat`),
  );
  if (container && container.total < os.totalmem()) return { ...container, scope: "container" as const };
  const machine = procMemory(await readText("/proc/meminfo"));
  if (machine) return { ...machine, scope: "server" as const };
  return { used: os.totalmem() - os.freemem(), total: os.totalmem(), scope: "server" as const };
}

// ── CPU ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type CpuSample = { at: number; busyUs: number; capacityCpus: number };

/** cgroup v2 cpu.max: "max 100000" (no limit) or "50000 100000" (half a CPU). */
export function cgroupCpuLimit(text: string | null) {
  const [quota, period] = (text ?? "").split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  if (!text || quota === "max" || !Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
}

/** /proc/stat's first line: total time and idle time, in clock ticks. */
export function procCpu(stat: string | null) {
  const line = (stat ?? "").split("\n").find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  const idle = values[3] + (values[4] ?? 0); // idle + iowait
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
  return { busy: total - idle, total };
}

/** Percent of the capacity used between two samples, clamped to 0-100. */
export function cpuPercentBetween(a: CpuSample, b: CpuSample) {
  const wallUs = (b.at - a.at) * 1000;
  if (wallUs <= 0) return null;
  const percent = ((b.busyUs - a.busyUs) / (wallUs * b.capacityCpus)) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

type ResourceMemory = {
  lastProc: { at: number; busy: number; total: number } | null;
  lastCgroup: CpuSample | null;
  cpuPercent: number | null;
  server: { at: number; value: ServerResources } | null;
  previews: { at: number; value: Map<string, PreviewResources> | null; pending: Promise<Map<string, PreviewResources> | null> | null };
};

function memory(): ResourceMemory {
  const holder = globalThis as unknown as { __mayflyResources?: ResourceMemory };
  holder.__mayflyResources ??= {
    lastProc: null,
    lastCgroup: null,
    cpuPercent: null,
    server: null,
    previews: { at: 0, value: null, pending: null },
  };
  return holder.__mayflyResources;
}

/** Update the CPU figure from the change since the last reading (at least a second apart). */
async function refreshCpu(now: number) {
  const mem = memory();
  const limit = cgroupCpuLimit(await readText(`${CGROUP}/cpu.max`));
  const cores = os.cpus().length || 1;
  if (limit !== null && limit < cores) {
    const usage = Number(/^usage_usec (\d+)$/m.exec((await readText(`${CGROUP}/cpu.stat`)) ?? "")?.[1]);
    if (Number.isFinite(usage)) {
      const sample = { at: now, busyUs: usage, capacityCpus: limit };
      if (mem.lastCgroup && now - mem.lastCgroup.at >= 1000) mem.cpuPercent = cpuPercentBetween(mem.lastCgroup, sample);
      if (!mem.lastCgroup || now - mem.lastCgroup.at >= 1000) mem.lastCgroup = sample;
      return limit;
    }
  }
  const proc = procCpu(await readText("/proc/stat"));
  if (proc) {
    const last = mem.lastProc;
    if (last && now - last.at >= 1000 && proc.total > last.total) {
      const percent = ((proc.busy - last.busy) / (proc.total - last.total)) * 100;
      mem.cpuPercent = Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
    }
    if (!last || now - last.at >= 1000) mem.lastProc = { at: now, ...proc };
  }
  return cores;
}

/** Server CPU and memory. Cached for 5 seconds. The first call waits a second so CPU has two readings. */
export async function serverResources(now = Date.now()): Promise<ServerResources> {
  const mem = memory();
  if (mem.server && now - mem.server.at < 5000) return mem.server.value;
  let cpus = await refreshCpu(now);
  if (mem.cpuPercent === null) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    cpus = await refreshCpu(Date.now());
  }
  const ram = await memoryNow();
  const value: ServerResources = {
    cpuPercent: mem.cpuPercent,
    cpus: Math.round(cpus * 100) / 100,
    memUsedBytes: ram.used,
    memTotalBytes: ram.total,
    memPercent: ram.total > 0 ? Math.round((ram.used / ram.total) * 1000) / 10 : 0,
    scope: ram.scope,
    checkedAt: new Date(now).toISOString(),
  };
  mem.server = { at: now, value };
  return value;
}

// ── Previews ────────────────────────────────────────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** "45.1MiB" → bytes. */
export function parseSize(text: string) {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim());
  if (!match) return null;
  const unit = UNITS[match[2].toLowerCase()];
  const value = Number(match[1]);
  return unit && Number.isFinite(value) ? Math.round(value * unit) : null;
}

/**
 * One `docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"` line.
 * Docker reports CPU as a share of one CPU, so a container limited to 0.5 CPU tops out at 50%; that's rescaled to
 * its own limit, so 100% always means "using everything it's allowed".
 */
export function parseStatsLine(line: string, cpuLimit: number) {
  const [name, cpu, memUsage, memPerc] = line.split("\t");
  if (!name || !cpu || !memUsage) return null;
  const [usedText, limitText] = memUsage.split("/");
  const used = parseSize(usedText ?? "");
  const limit = parseSize(limitText ?? "");
  const cpuRaw = Number(cpu.replace("%", ""));
  if (used === null || limit === null || !Number.isFinite(cpuRaw)) return null;
  const scaled = cpuLimit > 0 ? cpuRaw / cpuLimit : cpuRaw;
  const memPercent = Number((memPerc ?? "").replace("%", ""));
  return {
    name: name.trim(),
    usage: {
      cpuPercent: Math.round(Math.min(100, Math.max(0, scaled)) * 10) / 10,
      memUsedBytes: used,
      memLimitBytes: limit,
      memPercent: Number.isFinite(memPercent) ? memPercent : limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
    } satisfies PreviewResources,
  };
}

/** The CPU limit each preview container gets (PREVIEW_CPUS, default 0.5), as the gate applies it. */
export function previewCpuLimit(raw = process.env.PREVIEW_CPUS) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}

export function previewStatsAvailable() {
  return previewRuntime() === "docker" && getConfig().deployer !== "fake";
}

function dockerStats(): Promise<Map<string, PreviewResources> | null> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const byContainer = new Map<string, PreviewResources>();
        const limit = previewCpuLimit();
        for (const line of stdout.split("\n")) {
          const parsed = parseStatsLine(line, limit);
          if (parsed && parsed.name.startsWith("mayfly-app-")) byContainer.set(parsed.name, parsed.usage);
        }
        resolve(byContainer);
      },
    );
  });
}

/**
 * CPU and memory of each running preview container, keyed by container name (mayfly-app-<port>). Null when
 * previews don't run in Docker or Docker didn't answer. Cached for 10 seconds; callers at the same moment share one
 * `docker stats` run, which takes a couple of seconds.
 */
export async function previewResources(now = Date.now()): Promise<Map<string, PreviewResources> | null> {
  if (!previewStatsAvailable()) return null;
  const cache = memory().previews;
  if (cache.value && now - cache.at < 10_000) return cache.value;
  cache.pending ??= dockerStats().then((value) => {
    cache.value = value;
    cache.at = Date.now();
    cache.pending = null;
    return value;
  });
  return cache.pending;
}

/** The container a preview's app runs in: the gate listens on `port`, the app on `port + 1000`. */
export function previewContainerName(port: number) {
  return `mayfly-app-${port + 1000}`;
}

/** How full memory may get before the server alert (MEMORY_ALERT_PERCENT, 50-99, default 90). */
export function memoryAlertPercent(raw = process.env.MEMORY_ALERT_PERCENT) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 50 && value <= 99 ? value : 90;
}

/** Tests only. */
export function resetResourcesForTests() {
  const holder = globalThis as unknown as { __mayflyResources?: ResourceMemory };
  delete holder.__mayflyResources;
}
