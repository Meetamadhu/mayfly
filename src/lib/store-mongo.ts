import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { MongoClient, type Collection, type Db, type Filter } from "mongodb";
import type { State } from "./store";

// Far regions (e.g. Codespaces) often need >250 ms to the first address Node tries.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const STATE_ID = "state";
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_GIVE_UP_MS = 15_000;

type MongoStore = {
  state: State;
  dirty: boolean;
  owner: string;
};

type StateDoc = {
  _id: string;
  data: unknown;
  updatedAt: Date;
};

type LockDoc = {
  _id: string;
  owner: string | null;
  expiresAt: Date;
};

const mongoAls = new AsyncLocalStorage<MongoStore>();

let client: MongoClient | undefined;
let clientReady: Promise<MongoClient> | undefined;

function mongoUri() {
  return (process.env.MONGODB_URI ?? "").trim();
}

/** True when board/admin state should use MongoDB. Never log the URI. */
export function usesMongo() {
  return Boolean(mongoUri());
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
  return { asleepSeconds: raw.asleepSeconds, awakeSeconds: raw.awakeSeconds };
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
    lastSampleAt: raw.lastSampleAt,
    ...(days ? { days } : {}),
  };
}

function asState(value: unknown): State {
  if (!value || typeof value !== "object") return { environments: [] };
  const environments = (value as State).environments;
  if (!Array.isArray(environments)) return { environments: [] };
  const usage = asUsage((value as State).usage);
  return usage ? { environments, usage } : { environments };
}

async function getClient(): Promise<MongoClient> {
  const uri = mongoUri();
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (client) return client;
  if (!clientReady) {
    clientReady = (async () => {
      const next = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
      await next.connect();
      client = next;
      return next;
    })().catch((error) => {
      clientReady = undefined;
      throw error;
    });
  }
  return clientReady;
}

async function db(): Promise<Db> {
  return (await getClient()).db("mayfly");
}

async function stateCollection(): Promise<Collection<StateDoc>> {
  return (await db()).collection<StateDoc>("state");
}

async function locksCollection(): Promise<Collection<LockDoc>> {
  return (await db()).collection<LockDoc>("locks");
}

async function readStateDoc(): Promise<State> {
  const col = await stateCollection();
  const doc = await col.findOne({ _id: STATE_ID });
  return asState(doc?.data);
}

async function writeStateDoc(state: State): Promise<void> {
  const next = asState(state);
  const col = await stateCollection();
  await col.updateOne(
    { _id: STATE_ID },
    { $set: { data: next, updatedAt: new Date() } },
    { upsert: true },
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(owner: string): Promise<void> {
  const locks = await locksCollection();
  const deadline = Date.now() + LOCK_GIVE_UP_MS;
  while (Date.now() < deadline) {
    const now = new Date();
    try {
      const filter: Filter<LockDoc> = {
        _id: STATE_ID,
        $or: [{ owner: null }, { expiresAt: { $lt: now } }],
      };
      const result = await locks.findOneAndUpdate(
        filter,
        {
          $set: {
            owner,
            expiresAt: new Date(now.getTime() + LOCK_TTL_MS),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (result && result.owner === owner) return;
    } catch {
      // Upsert races on first create can throw duplicate key — retry.
    }
    await sleep(LOCK_RETRY_MS);
  }
  throw new Error("Could not acquire the Mayfly state lock within 15 seconds.");
}

async function releaseLock(owner: string): Promise<void> {
  const locks = await locksCollection();
  await locks.updateOne({ _id: STATE_ID, owner }, { $set: { owner: null } });
}

/** Read state. Inside exclusive(), returns the locked snapshot. */
export async function loadStateMongo(): Promise<State> {
  const held = mongoAls.getStore();
  if (held) return asState(held.state);
  return readStateDoc();
}

/** Write state. Inside exclusive(), updates the locked snapshot; flushed when the lock is released. */
export async function saveStateMongo(state: State): Promise<void> {
  const next = asState(state);
  const held = mongoAls.getStore();
  if (held) {
    held.state = next;
    held.dirty = true;
    return;
  }

  await withMongoExclusive(async () => {
    await saveStateMongo(next);
  });
}

/**
 * Run read-modify-write under a MongoDB lease lock.
 * Nested calls reuse the held lock. The callback runs once.
 */
export async function withMongoExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (mongoAls.getStore()) return fn();

  const owner = randomUUID();
  await acquireLock(owner);
  try {
    const state = await readStateDoc();
    const store: MongoStore = { state, dirty: false, owner };
    const result = await mongoAls.run(store, fn);
    if (store.dirty) await writeStateDoc(store.state);
    return result;
  } finally {
    await releaseLock(owner);
  }
}
