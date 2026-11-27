import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";

/**
 * A sandbox database for each preview. The repository's settings pick a kind (Postgres or MongoDB) and where the
 * data comes from: empty, a copy of a template database, or a script pasted into the settings. Each preview gets
 * its own database and its own login that can reach only that database, so one pull request's code can't read
 * another's data or the real one. The address goes to the app in an environment variable (DATABASE_URL by default).
 * Everything is removed when the preview is.
 *
 * The server needs an admin connection: PREVIEW_DB_POSTGRES_URL (and the `psql` program) for Postgres, or
 * PREVIEW_DB_MONGO_URL for MongoDB. Use a dedicated server, not the production one.
 */

export type DbKind = "postgres" | "mongo";
export type DbSeed = "empty" | "template" | "script";

export interface DbSettings {
  kind: DbKind;
  /** The environment variable the app reads. */
  envName: string;
  seed: DbSeed;
  /** The database to copy, when seed is "template". */
  template?: string;
  /** SQL (Postgres) or JSON `{ "collection": [documents] }` (MongoDB), when seed is "script". */
  script?: string;
}

export const MAX_SCRIPT_CHARS = 256 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const TEMPLATE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/;

export const DEFAULT_ENV_NAME: Record<DbKind, string> = { postgres: "DATABASE_URL", mongo: "MONGODB_URI" };

export type DbParse = { ok: true; db: DbSettings | null } | { ok: false; error: string };

/** Check the database part of a repository's settings. Null or "none" means no sandbox database. */
export function parseDbSettings(input: unknown, reservedProblem: (name: string) => string | null = () => null): DbParse {
  if (input === undefined || input === null) return { ok: true, db: null };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "The database settings must be an object." };
  const raw = input as Record<string, unknown>;
  if (raw.kind === undefined || raw.kind === null || raw.kind === "" || raw.kind === "none") return { ok: true, db: null };
  if (raw.kind !== "postgres" && raw.kind !== "mongo") return { ok: false, error: "Choose Postgres, MongoDB or no database." };
  const kind: DbKind = raw.kind;
  const envName = typeof raw.envName === "string" && raw.envName.trim() ? raw.envName.trim() : DEFAULT_ENV_NAME[kind];
  if (!NAME_PATTERN.test(envName)) return { ok: false, error: `“${envName.slice(0, 40)}” isn't a valid variable name.` };
  const problem = reservedProblem(envName);
  if (problem) return { ok: false, error: problem };
  const seed = raw.seed ?? "empty";
  if (seed !== "empty" && seed !== "template" && seed !== "script") return { ok: false, error: "Choose empty, a template database or a script." };
  const db: DbSettings = { kind, envName, seed };
  if (seed === "template") {
    const template = typeof raw.template === "string" ? raw.template.trim() : "";
    if (!TEMPLATE_PATTERN.test(template)) return { ok: false, error: "Enter the name of the template database to copy." };
    db.template = template;
  }
  if (seed === "script") {
    const script = typeof raw.script === "string" ? raw.script : "";
    if (!script.trim()) return { ok: false, error: kind === "postgres" ? "Paste the SQL to run on each new database." : "Paste the JSON to load into each new database." };
    if (script.length > MAX_SCRIPT_CHARS) return { ok: false, error: "The script is too long (256 KB at most)." };
    if (script.includes("\u0000")) return { ok: false, error: "The script has a character that can't be used." };
    if (kind === "mongo") {
      const problem = mongoSeedProblem(script);
      if (problem) return { ok: false, error: problem };
    }
    db.script = script;
  }
  return { ok: true, db };
}

export function asStoredDb(value: unknown): DbSettings | undefined {
  const parsed = parseDbSettings(value);
  return parsed.ok && parsed.db ? parsed.db : undefined;
}

/** Why a MongoDB seed can't be used, or null: it must be an object whose values are lists of documents. */
export function mongoSeedProblem(script: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(script);
  } catch {
    return "The MongoDB seed isn't valid JSON.";
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return 'The seed must look like { "users": [ { … } ] }.';
  for (const [name, docs] of Object.entries(data as Record<string, unknown>)) {
    if (!/^[A-Za-z_][\w.-]{0,100}$/.test(name) || name.startsWith("system.")) return `“${name.slice(0, 40)}” can't be a collection name.`;
    if (!Array.isArray(docs) || docs.some((doc) => !doc || typeof doc !== "object" || Array.isArray(doc))) {
      return `${name} must be a list of documents.`;
    }
  }
  return null;
}

// ───────────────────────────── names, passwords, addresses ─────────────────────────────

/** `pv_<repo words>_<pr>_<hash>`: lower case letters, digits and _, at most 60 characters, unique per repo and pull request. */
export function sandboxName(repository: string, prNumber: number) {
  const repo = repository.trim().toLowerCase();
  const hash = createHash("sha256").update(repo).digest("hex").slice(0, 6);
  const words = repo.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
  return `pv_${words}_${prNumber}_${hash}`;
}

/** The login's password. The same preview always gets the same one, so provisioning twice is harmless. */
export function sandboxPassword(name: string, secret: string) {
  return createHmac("sha256", secret).update(`mayfly-sandbox-db:${name}`).digest("base64url").slice(0, 32);
}

export function secretFromEnv(env: Record<string, string | undefined> = process.env) {
  const value = (env["MAYFLY_SECRETS_KEY"] ?? "").trim();
  return value.length >= 32 ? value : null;
}

export interface PgTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode: string | null;
}

export function parsePgUrl(value: string): PgTarget | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return {
      host: url.hostname,
      port: url.port || "5432",
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
      sslmode: url.searchParams.get("sslmode"),
    };
  } catch {
    return null;
  }
}

/** The address a preview's app connects to. `appHost` replaces the admin host when apps reach the server another way. */
export function postgresAppUrl(admin: PgTarget, name: string, password: string, appHost?: string) {
  const query = admin.sslmode ? `?sslmode=${encodeURIComponent(admin.sslmode)}` : "";
  return `postgres://${name}:${password}@${appHost || admin.host}:${admin.port}/${name}${query}`;
}

/** The MongoDB admin address with this preview's login and database swapped in. Handles lists of hosts too. */
export function mongoAppUrl(adminUrl: string, name: string, password: string, appHost?: string) {
  const match = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]+)(?:\/[^?]*)?(?:\?(.*))?$/.exec(adminUrl.trim());
  if (!match) return null;
  let hosts = match[2];
  if (appHost) hosts = hosts.replace(/^[^:,]+/, appHost);
  const query = (match[3] ?? "")
    .split("&")
    .filter((part) => part && !/^authSource=/i.test(part));
  query.push(`authSource=${name}`);
  return `${match[1]}${name}:${password}@${hosts}/${name}?${query.join("&")}`;
}

// ───────────────────────────── Postgres, through psql ─────────────────────────────

export interface PsqlCall {
  target: PgTarget;
  /** One SQL command, run with -c. */
  sql?: string;
  /** A script given on standard input. */
  stdin?: string;
}
export type PsqlRunner = (call: PsqlCall) => Promise<string>;

export const runPsql: PsqlRunner = (call) =>
  new Promise((resolve, reject) => {
    const { target } = call;
    const args = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", ...(call.sql ? ["-c", call.sql] : [])];
    const child = execFile(
      process.env.PREVIEW_PSQL_PATH?.trim() || "psql",
      args,
      {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "",
          PGHOST: target.host,
          PGPORT: target.port,
          PGUSER: target.user,
          PGPASSWORD: target.password,
          PGDATABASE: target.database,
          ...(target.sslmode ? { PGSSLMODE: target.sslmode } : {}),
          PGCONNECT_TIMEOUT: "15",
        } as unknown as NodeJS.ProcessEnv, // only these variables: not the server's own settings
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        const text = String(stderr || error.message).split("\n").find((line) => line.trim()) ?? "psql failed";
        if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("The psql program isn't installed on the server (or set PREVIEW_PSQL_PATH)."));
        else reject(new Error(text.replace(/password[^\s]*/gi, "password…").slice(0, 300)));
      },
    );
    if (call.stdin !== undefined) child.stdin?.end(call.stdin);
  });

/** Create the role and database for a preview (or find them), and load the seed into a new database. */
export async function provisionPostgres(
  db: DbSettings,
  name: string,
  password: string,
  adminUrl: string,
  run: PsqlRunner = runPsql,
  appHost?: string,
): Promise<{ url: string; created: boolean }> {
  const admin = parsePgUrl(adminUrl);
  if (!admin) throw new Error("PREVIEW_DB_POSTGRES_URL isn't a postgres:// address.");
  const role = `"${name}"`;
  await run({
    target: admin,
    sql: `DO $mayfly$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${password}'; ELSE ALTER ROLE ${role} LOGIN PASSWORD '${password}'; END IF; END $mayfly$`,
  });
  const exists = (await run({ target: admin, sql: `SELECT 1 FROM pg_database WHERE datname = '${name}'` })) === "1";
  let created = false;
  if (!exists) {
    // CREATE DATABASE can't run beside other commands, so each is its own call. The admin must be a member of the role to make it the owner.
    await run({ target: admin, sql: `GRANT ${role} TO CURRENT_USER` }).catch(() => undefined);
    const template = db.seed === "template" && db.template ? ` TEMPLATE "${db.template.replace(/"/g, "")}"` : "";
    await run({ target: admin, sql: `CREATE DATABASE ${role} OWNER ${role}${template}` });
    await run({ target: admin, sql: `REVOKE ALL ON DATABASE ${role} FROM PUBLIC` });
    created = true;
    if (db.seed === "script" && db.script) {
      // Run as the preview's own login so the app owns what the script makes.
      const asRole: PgTarget = { ...admin, user: name, password, database: name };
      try {
        await run({ target: asRole, stdin: db.script });
      } catch (error) {
        await dropPostgres(name, adminUrl, run).catch(() => undefined);
        throw new Error(`The database script failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }
  return { url: postgresAppUrl(admin, name, password, appHost), created };
}

export async function dropPostgres(name: string, adminUrl: string, run: PsqlRunner = runPsql) {
  const admin = parsePgUrl(adminUrl);
  if (!admin) return;
  await run({ target: admin, sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)` });
  await run({ target: admin, sql: `DROP ROLE IF EXISTS "${name}"` });
}

// ───────────────────────────── MongoDB, through the driver ─────────────────────────────

export interface MongoCollectionLike {
  find(query: object): { toArray(): Promise<object[]> };
  insertMany(docs: object[]): Promise<unknown>;
  listIndexes?(): { toArray(): Promise<{ key: Record<string, number>; name: string; unique?: boolean }[]> };
  createIndex?(key: Record<string, number>, options?: object): Promise<unknown>;
}
export interface MongoDbLike {
  command(command: object): Promise<unknown>;
  listCollections(filter?: object, options?: object): { toArray(): Promise<{ name: string }[]> };
  createCollection(name: string): Promise<unknown>;
  collection(name: string): MongoCollectionLike;
  dropDatabase(): Promise<unknown>;
}
export interface MongoClientLike {
  db(name: string): MongoDbLike;
  close(): Promise<void>;
}
export type MongoFactory = (url: string) => Promise<MongoClientLike>;

export const connectMongo: MongoFactory = async (url) => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  return client as unknown as MongoClientLike;
};

const MARKER = "_mayfly_sandbox";

export async function provisionMongo(
  db: DbSettings,
  name: string,
  password: string,
  adminUrl: string,
  connect: MongoFactory = connectMongo,
  appHost?: string,
): Promise<{ url: string; created: boolean }> {
  const url = mongoAppUrl(adminUrl, name, password, appHost);
  if (!url) throw new Error("PREVIEW_DB_MONGO_URL isn't a mongodb:// address.");
  const client = await connect(adminUrl);
  try {
    const target = client.db(name);
    const created = (await target.listCollections({ name: MARKER }).toArray()).length === 0;
    if (created) {
      await target.createCollection(MARKER);
      if (db.seed === "template" && db.template) await copyCollections(client.db(db.template), target);
      if (db.seed === "script" && db.script) {
        try {
          const data = JSON.parse(db.script) as Record<string, object[]>;
          for (const [collection, docs] of Object.entries(data)) if (docs.length > 0) await target.collection(collection).insertMany(docs);
        } catch (error) {
          await target.dropDatabase().catch(() => undefined);
          throw new Error(`The database seed failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    }
    // The login: created once, and its password reset to the expected one if it already exists.
    const roles = [{ role: "dbOwner", db: name }];
    await target.command({ createUser: name, pwd: password, roles }).catch(async () => {
      await target.command({ updateUser: name, pwd: password, roles });
    });
    return { url, created };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function copyCollections(from: MongoDbLike, to: MongoDbLike) {
  for (const { name } of await from.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith("system.")) continue;
    const source = from.collection(name);
    const docs = await source.find({}).toArray();
    if (docs.length > 0) await to.collection(name).insertMany(docs);
    const indexes = (await source.listIndexes?.().toArray()) ?? [];
    for (const index of indexes) {
      if (index.name === "_id_") continue;
      await to.collection(name).createIndex?.(index.key, { unique: index.unique === true, name: index.name });
    }
  }
}

export async function dropMongo(name: string, adminUrl: string, connect: MongoFactory = connectMongo) {
  const client = await connect(adminUrl);
  try {
    const target = client.db(name);
    await target.command({ dropUser: name }).catch(() => undefined);
    await target.dropDatabase();
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ───────────────────────────── together ─────────────────────────────

export interface SandboxDeps {
  env?: Record<string, string | undefined>;
  psql?: PsqlRunner;
  mongo?: MongoFactory;
}

function adminUrlFor(kind: DbKind, env: Record<string, string | undefined>) {
  return (env[kind === "postgres" ? "PREVIEW_DB_POSTGRES_URL" : "PREVIEW_DB_MONGO_URL"] ?? "").trim();
}

/** Why sandbox databases of this kind can't be made on this server, or null. */
export function sandboxProblem(kind: DbKind, env: Record<string, string | undefined> = process.env): string | null {
  if (!adminUrlFor(kind, env)) {
    return kind === "postgres"
      ? "Sandbox Postgres databases need PREVIEW_DB_POSTGRES_URL on the server (an admin login to a dedicated Postgres)."
      : "Sandbox MongoDB databases need PREVIEW_DB_MONGO_URL on the server (an admin login to a dedicated MongoDB).";
  }
  if (!secretFromEnv(env)) return "Sandbox databases need MAYFLY_SECRETS_KEY on the server (it derives each preview's password).";
  return null;
}

/** Make (or find) a preview's sandbox database. Returns the variable to give the app. */
export async function provisionSandbox(db: DbSettings, repository: string, prNumber: number, deps: SandboxDeps = {}) {
  const env = deps.env ?? process.env;
  const problem = sandboxProblem(db.kind, env);
  if (problem) throw new Error(problem);
  const name = sandboxName(repository, prNumber);
  const password = sandboxPassword(name, secretFromEnv(env) as string);
  const adminUrl = adminUrlFor(db.kind, env);
  const appHost = (env["PREVIEW_DB_APP_HOST"] ?? "").trim() || undefined;
  const made =
    db.kind === "postgres"
      ? await provisionPostgres(db, name, password, adminUrl, deps.psql, appHost)
      : await provisionMongo(db, name, password, adminUrl, deps.mongo, appHost);
  return { envName: db.envName, url: made.url, created: made.created, name };
}

export async function dropSandbox(kind: DbKind, repository: string, prNumber: number, deps: SandboxDeps = {}) {
  const env = deps.env ?? process.env;
  const adminUrl = adminUrlFor(kind, env);
  if (!adminUrl) return;
  const name = sandboxName(repository, prNumber);
  if (kind === "postgres") await dropPostgres(name, adminUrl, deps.psql);
  else await dropMongo(name, adminUrl, deps.mongo);
}
