import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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

export const exclusive = createExclusive("__previewStateLock");

export interface State {
  environments: import("./types").Environment[];
}

export function dataDir() {
  if (process.env.VERCEL) return path.join("/tmp", "orchestrator-data");
  return path.join(process.cwd(), "data");
}

function stateFile() {
  return path.join(dataDir(), "state.json");
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
  const state = await readJson<State>(stateFile(), { environments: [] });
  if (!Array.isArray(state.environments)) return { environments: [] };
  return state;
}

export async function saveState(state: State): Promise<void> {
  await writeJson(stateFile(), state);
}
