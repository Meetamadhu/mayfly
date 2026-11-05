import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import type { State } from "./store";

const STATE_ID = 1;

type PgStore = {
  client: PoolClient;
  /** Latest snapshot held under FOR UPDATE in this transaction. */
  state: State;
};

const pgTx = new AsyncLocalStorage<PgStore>();

let pool: Pool | undefined;
let schemaReady: Promise<void> | undefined;

function connectionString() {
  // channel_binding is fine for some clients; node-pg is happier without it.
  return (process.env.DATABASE_URL ?? "")
    .trim()
    .replace(/([?&])channel_binding=require&?/i, "$1")
    .replace(/[?&]$/, "");
}

/** True when board/admin state should use Postgres. Never log the URL. */
export function usesPostgres() {
  return Boolean(connectionString());
}

function getPool() {
  const url = connectionString();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      // Neon (and most hosted Postgres) require TLS.
      ssl: { rejectUnauthorized: true },
      max: 10,
    });
    pool.on("error", (error) => {
      console.error("Postgres pool error", error.message);
    });
  }
  return pool;
}

function asState(value: unknown): State {
  if (!value || typeof value !== "object") return { environments: [] };
  const environments = (value as State).environments;
  if (!Array.isArray(environments)) return { environments: [] };
  return { environments };
}

async function ensureSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mayfly_state (
      id int PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    `
      INSERT INTO mayfly_state (id, data, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (id) DO NOTHING
    `,
    [STATE_ID, JSON.stringify({ environments: [] })],
  );
}

function ensureSchemaOnce() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await getPool().connect();
      try {
        await ensureSchema(client);
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

async function selectState(client: PoolClient, forUpdate: boolean): Promise<State> {
  const sql = forUpdate
    ? `SELECT data FROM mayfly_state WHERE id = $1 FOR UPDATE`
    : `SELECT data FROM mayfly_state WHERE id = $1`;
  const result = await client.query<{ data: unknown }>(sql, [STATE_ID]);
  if (result.rows.length === 0) {
    await ensureSchema(client);
    const again = await client.query<{ data: unknown }>(sql, [STATE_ID]);
    return asState(again.rows[0]?.data);
  }
  return asState(result.rows[0]?.data);
}

/** Read state. Inside exclusive(), returns the locked snapshot. */
export async function loadStatePg(): Promise<State> {
  const tx = pgTx.getStore();
  if (tx) return asState(tx.state);
  await ensureSchemaOnce();
  const client = await getPool().connect();
  try {
    return await selectState(client, false);
  } finally {
    client.release();
  }
}

/** Write state. Inside exclusive(), updates the locked row in the same transaction. */
export async function saveStatePg(state: State): Promise<void> {
  const next = asState(state);
  const tx = pgTx.getStore();
  if (tx) {
    await tx.client.query(
      `
        UPDATE mayfly_state
        SET data = $2::jsonb, updated_at = now()
        WHERE id = $1
      `,
      [STATE_ID, JSON.stringify(next)],
    );
    tx.state = next;
    return;
  }

  // Rare path: save outside exclusive — still serialize with FOR UPDATE.
  await withPgExclusive(async () => {
    await saveStatePg(next);
  });
}

/**
 * Run read-modify-write under one Postgres transaction with SELECT ... FOR UPDATE.
 * Replaces the in-process state lock when DATABASE_URL is set.
 */
export async function withPgExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (pgTx.getStore()) return fn();

  await ensureSchemaOnce();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const state = await selectState(client, true);
    const result = await pgTx.run({ client, state }, fn);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }
}
