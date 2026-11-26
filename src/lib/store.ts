import { asStoredSettings } from "./preview-settings-shape";
import { asStoredPlan } from "./plans";
import { asBilling } from "./billing";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { asStoredPolicy } from "./policy";
import { loadStateMongo, saveStateMongo, usesMongo, withMongoExclusive } from "./store-mongo";

const locks = globalThis as unknown as Record<string, Promise<unknown> | undefined>;

export function createExclusive(key: string) {
  return function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = locks[key] ?? Promise.resolve();
    const run = previous.then(fn, fn);
    locks[key] = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const fileExclusive = createExclusive("__previewStateLock");

/**
 * Serialize read-modify-write of environment state.
 * JSON mode: in-process queue. MongoDB mode: lease lock on the state document.
 */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (usesMongo()) return withMongoExclusive(fn);
  return fileExclusive(fn);
}

export interface State {
  environments: import("./types").Environment[];
  usage?: import("./types").UsageMonth;
  policy?: import("./policy").PreviewPolicy;
  /** Settings for each repository's previews: size and (encrypted) environment variables. */
  previewSettings?: import("./preview-settings-shape").PreviewSettings;
  /** The plan picked on the pricing page (a demo: no payment). Unset means the default plan. */
  plan?: import("./plans").StoredPlan;
  /** Prepaid credit for Pay as you go and the Razorpay orders that added it. */
  billing?: import("./billing").Billing;
}

export function dataDir() {
  if (process.env.VERCEL) return path.join("/tmp", "orchestrator-data");
  return path.join(process.cwd(), "data");
}

function stateFile() {
  return path.join(dataDir(), "state.json");
}

/** The size-weighted totals, when present and valid. */
function weightedOf(raw: Record<string, unknown>) {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return {
    ...(ok(raw.awakeWeighted) ? { awakeWeighted: raw.awakeWeighted } : {}),
    ...(ok(raw.asleepWeighted) ? { asleepWeighted: raw.asleepWeighted } : {}),
  };
}

function asUsageDay(value: unknown): import("./types").UsageDay | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.asleepSeconds !== "number" || !Number.isFinite(raw.asleepSeconds) || raw.asleepSeconds < 0) {
    return null;
  }
  if (typeof raw.awakeSeconds !== "number" || !Number.isFinite(raw.awakeSeconds) || raw.awakeSeconds < 0) {
    return null;
  }
  return { asleepSeconds: raw.asleepSeconds, awakeSeconds: raw.awakeSeconds, ...weightedOf(raw) };
}

function asUsageDays(value: unknown): Record<string, import("./types").UsageDay> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const days: Record<string, import("./types").UsageDay> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const day = asUsageDay(entry);
    if (day) days[key] = day;
  }
  return days;
}

function asUsage(value: unknown): import("./types").UsageMonth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.month !== "string" || !/^\d{4}-\d{2}$/.test(raw.month)) return undefined;
  if (typeof raw.asleepSeconds !== "number" || !Number.isFinite(raw.asleepSeconds) || raw.asleepSeconds < 0) {
    return undefined;
  }
  if (typeof raw.awakeSeconds !== "number" || !Number.isFinite(raw.awakeSeconds) || raw.awakeSeconds < 0) {
    return undefined;
  }
  if (typeof raw.lastSampleAt !== "string" || !Number.isFinite(Date.parse(raw.lastSampleAt))) return undefined;
  const days = asUsageDays(raw.days);
  return {
    month: raw.month,
    asleepSeconds: raw.asleepSeconds,
    awakeSeconds: raw.awakeSeconds,
    ...weightedOf(raw),
    lastSampleAt: raw.lastSampleAt,
    ...(days ? { days } : {}),
  };
}

export function asState(value: unknown): State {
  if (!value || typeof value !== "object") return { environments: [] };
  const environments = (value as State).environments;
  if (!Array.isArray(environments)) return { environments: [] };
  const usage = asUsage((value as State).usage);
  const policy = asStoredPolicy((value as State).policy);
  const previewSettings = asStoredSettings((value as State).previewSettings);
  const plan = asStoredPlan((value as State).plan);
  const billing = asBilling((value as State).billing);
  return {
    environments,
    ...(usage ? { usage } : {}),
    ...(policy ? { policy } : {}),
    ...(previewSettings ? { previewSettings } : {}),
    ...(plan ? { plan } : {}),
    ...(billing ? { billing } : {}),
  };
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(tmp, file);
}

export async function loadState(): Promise<State> {
  if (usesMongo()) return loadStateMongo();
  const state = await readJson<State>(stateFile(), { environments: [] });
  return asState(state);
}

export async function saveState(state: State): Promise<void> {
  if (usesMongo()) {
    await saveStateMongo(state);
    return;
  }
  await writeJson(stateFile(), asState(state));
}
