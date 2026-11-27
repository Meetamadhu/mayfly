/**
 * Sandbox databases for previews, with stand-ins for psql and the MongoDB driver (no database server is needed):
 * what gets created, for whom, the address the app is given, seeding, removal, and the checks on the settings.
 * Run with: npx tsx scripts/test-sandbox-db.ts
 */
import assert from "node:assert/strict";
import {
  asStoredDb,
  dropSandbox,
  mongoAppUrl,
  mongoSeedProblem,
  parseDbSettings,
  parsePgUrl,
  provisionSandbox,
  sandboxName,
  sandboxPassword,
  sandboxProblem,
  type MongoClientLike,
  type MongoDbLike,
  type PsqlCall,
} from "../src/lib/sandbox-db";

const SECRET = "x".repeat(40);
const PG_ADMIN = "postgres://admin:adminpw@db.internal:5433/postgres?sslmode=require";
const MONGO_ADMIN = "mongodb://admin:adminpw@mongo.internal:27018/?replicaSet=rs0";
const env = { MAYFLY_SECRETS_KEY: SECRET, PREVIEW_DB_POSTGRES_URL: PG_ADMIN, PREVIEW_DB_MONGO_URL: MONGO_ADMIN };

// Names and passwords: stable for one preview, different between previews, safe to put in SQL.
const name = sandboxName("Acme/Web-Site", 42);
assert.match(name, /^pv_acme_web_site_42_[0-9a-f]{6}$/);
assert.equal(sandboxName("acme/web-site", 42), name, "repository case doesn't matter");
assert.notEqual(sandboxName("acme/web-site", 43), name);
assert.notEqual(sandboxName("acme/web_site", 42), name, "repositories that differ only in punctuation don't collide");
assert.ok(sandboxName("a".repeat(80) + "/b".repeat(40), 123456).length <= 60);
const password = sandboxPassword(name, SECRET);
assert.equal(password, sandboxPassword(name, SECRET));
assert.notEqual(password, sandboxPassword(sandboxName("acme/web-site", 43), SECRET));
assert.notEqual(password, sandboxPassword(name, "y".repeat(40)));
assert.match(password, /^[A-Za-z0-9_-]{32}$/);

// Addresses.
assert.deepEqual(parsePgUrl(PG_ADMIN), { host: "db.internal", port: "5433", user: "admin", password: "adminpw", database: "postgres", sslmode: "require" });
assert.equal(parsePgUrl("mysql://x"), null);
assert.equal(mongoAppUrl(MONGO_ADMIN, "pv_x", "pw", undefined), "mongodb://pv_x:pw@mongo.internal:27018/pv_x?replicaSet=rs0&authSource=pv_x");
assert.equal(mongoAppUrl("mongodb+srv://a:b@cluster.example.net/admin?authSource=admin&retryWrites=true", "pv_x", "pw"), "mongodb+srv://pv_x:pw@cluster.example.net/pv_x?retryWrites=true&authSource=pv_x");
assert.equal(mongoAppUrl("mongodb://h1:1,h2:2/", "n", "p", "host.docker.internal"), "mongodb://n:p@host.docker.internal:1,h2:2/n?authSource=n");
assert.equal(mongoAppUrl("junk", "n", "p"), null);

// What's needed on the server.
assert.match(sandboxProblem("postgres", {}) ?? "", /PREVIEW_DB_POSTGRES_URL/);
assert.match(sandboxProblem("mongo", {}) ?? "", /PREVIEW_DB_MONGO_URL/);
assert.match(sandboxProblem("postgres", { PREVIEW_DB_POSTGRES_URL: PG_ADMIN }) ?? "", /MAYFLY_SECRETS_KEY/);
assert.equal(sandboxProblem("postgres", env), null);
assert.equal(sandboxProblem("mongo", env), null);

// Settings input.
assert.deepEqual(parseDbSettings(undefined), { ok: true, db: null });
assert.deepEqual(parseDbSettings({ kind: "none" }), { ok: true, db: null });
assert.deepEqual(parseDbSettings({ kind: "postgres" }), { ok: true, db: { kind: "postgres", envName: "DATABASE_URL", seed: "empty" } });
assert.deepEqual(parseDbSettings({ kind: "mongo", envName: "MONGO_URL", seed: "template", template: "shop_seed" }), { ok: true, db: { kind: "mongo", envName: "MONGO_URL", seed: "template", template: "shop_seed" } });
for (const bad of [
  { kind: "mysql" },
  { kind: "postgres", envName: "1BAD" },
  { kind: "postgres", seed: "template" },
  { kind: "postgres", seed: "template", template: "x; DROP DATABASE y" },
  { kind: "postgres", seed: "script", script: "   " },
  { kind: "postgres", seed: "script", script: "a".repeat(256 * 1024 + 1) },
  { kind: "postgres", seed: "magic" },
  { kind: "mongo", seed: "script", script: "not json" },
  { kind: "mongo", seed: "script", script: "[1,2]" },
  { kind: "mongo", seed: "script", script: '{"users": "nope"}' },
  { kind: "mongo", seed: "script", script: '{"system.users": []}' },
  "text",
]) {
  assert.equal(parseDbSettings(bad).ok, false, JSON.stringify(bad).slice(0, 60));
}
assert.equal(parseDbSettings({ kind: "postgres", envName: "PREVIEW_URL" }, (n) => (n.startsWith("PREVIEW_") ? "reserved" : null)).ok, false, "reserved names are refused");
assert.equal(asStoredDb({ kind: "postgres", envName: "!!" }), undefined);
assert.equal(mongoSeedProblem('{"users":[{"a":1}]}'), null);

async function main() {
  // Postgres: a role and a database for this preview, the seed run as that role, the app's address.
  const calls: PsqlCall[] = [];
  const psql = async (call: PsqlCall) => {
    calls.push(call);
    return call.sql?.startsWith("SELECT 1 FROM pg_database") ? "" : "";
  };
  const script = "CREATE TABLE users (id int);\nINSERT INTO users VALUES (1);";
  const made = await provisionSandbox({ kind: "postgres", envName: "DATABASE_URL", seed: "script", script }, "acme/web-site", 42, { env, psql });
  assert.equal(made.envName, "DATABASE_URL");
  assert.equal(made.created, true);
  assert.equal(made.url, `postgres://${name}:${password}@db.internal:5433/${name}?sslmode=require`);
  const sql = calls.map((call) => call.sql ?? "<script>");
  assert.match(sql[0], new RegExp(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`));
  assert.ok(sql.some((line) => line === `CREATE DATABASE "${name}" OWNER "${name}"`));
  assert.ok(sql.some((line) => line === `REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`), "other previews' logins can't connect");
  const seedCall = calls.at(-1)!;
  assert.equal(seedCall.stdin, script);
  assert.equal(seedCall.target.user, name, "the seed runs as the preview's own login");
  assert.equal(seedCall.target.database, name);
  assert.ok(calls.every((call) => call.target.host === "db.internal" && call.target.port === "5433"));

  // The same preview again finds its database and doesn't seed twice.
  calls.length = 0;
  const again = await provisionSandbox(
    { kind: "postgres", envName: "DATABASE_URL", seed: "script", script },
    "acme/web-site",
    42,
    { env, psql: async (call) => (call.sql?.startsWith("SELECT 1 FROM pg_database") ? "1" : "") },
  );
  assert.equal(again.created, false);
  assert.equal(again.url, made.url);

  // A template database is copied; the address can be changed for apps that reach the server another way.
  calls.length = 0;
  const templated = await provisionSandbox({ kind: "postgres", envName: "DB", seed: "template", template: "shop_seed" }, "acme/web-site", 42, { env: { ...env, PREVIEW_DB_APP_HOST: "host.docker.internal" }, psql });
  assert.ok(calls.some((call) => call.sql === `CREATE DATABASE "${name}" OWNER "${name}" TEMPLATE "shop_seed"`));
  assert.match(templated.url, /@host\.docker\.internal:5433\//);

  // A seed that fails removes what was made, and says why.
  const dropped: string[] = [];
  await assert.rejects(
    provisionSandbox({ kind: "postgres", envName: "DATABASE_URL", seed: "script", script: "BROKEN" }, "acme/web-site", 7, {
      env,
      psql: async (call) => {
        if (call.stdin) throw new Error('syntax error at or near "BROKEN"');
        if (call.sql?.startsWith("DROP DATABASE")) dropped.push(call.sql);
        return "";
      },
    }),
    /The database script failed: syntax error/,
  );
  assert.equal(dropped.length, 1, "a half-made database is cleaned up");

  // Removing it.
  calls.length = 0;
  await dropSandbox("postgres", "acme/web-site", 42, { env, psql });
  assert.deepEqual(calls.map((call) => call.sql), [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, `DROP ROLE IF EXISTS "${name}"`]);
  calls.length = 0;
  await dropSandbox("postgres", "acme/web-site", 42, { env: {}, psql });
  assert.equal(calls.length, 0, "with no server configured there's nothing to remove");

  // Without the server settings, a deploy gets a clear message.
  await assert.rejects(provisionSandbox({ kind: "postgres", envName: "DATABASE_URL", seed: "empty" }, "acme/web-site", 1, { env: {}, psql }), /PREVIEW_DB_POSTGRES_URL/);

  // MongoDB, with a stand-in driver that remembers what it was told.
  const state = { collections: new Set<string>(), commands: [] as object[], inserted: {} as Record<string, object[]>, droppedDbs: [] as string[], opened: [] as string[], closed: 0, templateDocs: { carts: [{ _id: 1, sku: "a" }] } as Record<string, object[]> };
  const fakeDb = (dbName: string): MongoDbLike => ({
    command: async (command) => {
      state.commands.push({ db: dbName, ...command });
      if ("createUser" in command && state.commands.filter((c) => "createUser" in c).length > 1) throw new Error("user already exists");
      return {};
    },
    listCollections: (filter?: object) => ({
      toArray: async () => {
        if (dbName === "shop_seed") return Object.keys(state.templateDocs).map((n) => ({ name: n }));
        const wanted = (filter as { name?: string } | undefined)?.name;
        return [...state.collections].filter((n) => !wanted || n === wanted).map((n) => ({ name: n }));
      },
    }),
    createCollection: async (collection) => void state.collections.add(collection),
    collection: (collection) => ({
      find: () => ({ toArray: async () => state.templateDocs[collection] ?? [] }),
      insertMany: async (docs) => void (state.inserted[`${dbName}.${collection}`] = docs),
    }),
    dropDatabase: async () => void state.droppedDbs.push(dbName),
  });
  const connect = async (url: string): Promise<MongoClientLike> => {
    state.opened.push(url);
    return { db: fakeDb, close: async () => void state.closed++ };
  };
  const mongoName = sandboxName("acme/web-site", 9);
  const mongoMade = await provisionSandbox(
    { kind: "mongo", envName: "MONGODB_URI", seed: "script", script: '{"users":[{"name":"ann"}],"empty":[]}' },
    "acme/web-site",
    9,
    { env, mongo: connect },
  );
  assert.equal(mongoMade.created, true);
  assert.equal(mongoMade.url, `mongodb://${mongoName}:${sandboxPassword(mongoName, SECRET)}@mongo.internal:27018/${mongoName}?replicaSet=rs0&authSource=${mongoName}`);
  assert.deepEqual(state.inserted[`${mongoName}.users`], [{ name: "ann" }]);
  assert.ok(!(`${mongoName}.empty` in state.inserted));
  assert.deepEqual(state.commands[0], { db: mongoName, createUser: mongoName, pwd: sandboxPassword(mongoName, SECRET), roles: [{ role: "dbOwner", db: mongoName }] });
  assert.equal(state.opened[0], MONGO_ADMIN, "it connects as the admin, and the app gets only its own login");
  assert.equal(state.closed, 1);

  // Again: the marker is found, nothing is seeded again, and the password is reset.
  state.inserted = {};
  const mongoAgain = await provisionSandbox({ kind: "mongo", envName: "MONGODB_URI", seed: "script", script: '{"users":[{"name":"ann"}]}' }, "acme/web-site", 9, { env, mongo: connect });
  assert.equal(mongoAgain.created, false);
  assert.deepEqual(state.inserted, {});
  assert.ok(state.commands.some((c) => "updateUser" in c));

  // Copying a template database.
  state.collections.clear();
  state.inserted = {};
  await provisionSandbox({ kind: "mongo", envName: "MONGODB_URI", seed: "template", template: "shop_seed" }, "acme/web-site", 10, { env, mongo: connect });
  assert.deepEqual(state.inserted[`${sandboxName("acme/web-site", 10)}.carts`], [{ _id: 1, sku: "a" }]);

  // Removal drops the login and the database.
  state.commands.length = 0;
  await dropSandbox("mongo", "acme/web-site", 9, { env, mongo: connect });
  assert.deepEqual(state.commands, [{ db: mongoName, dropUser: mongoName }]);
  assert.deepEqual(state.droppedDbs, [mongoName]);

  console.log("sandbox-db: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
