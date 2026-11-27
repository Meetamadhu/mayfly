import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { NAME_PATTERN, type PreviewSettings, type RepoSettings, type StoredVar } from "./preview-settings-shape";
import { isPreviewSize, type PreviewSize } from "./sizes";
import { loadState } from "./store";
import { parseChecks, type SmokeCheck } from "./smoke";
import { parseDbSettings, sandboxProblem, secretFromEnv, type DbKind, type DbSettings } from "./sandbox-db";
import { cleanProductionUrl } from "./visual-diff";

/**
 * Preview settings for each repository: the size of previews opened from GitHub, and environment variables (test
 * database URLs, API keys, NEXT_PUBLIC_ values) handed to every preview of that repository.
 *
 * Values are encrypted with MAYFLY_SECRETS_KEY (AES-256-GCM) before they're saved, so the state file, MongoDB and
 * backups never hold them in plain text, and they're never sent back to the browser. Without the key, variables
 * can't be saved (the size still can). Every pull request's code can read its preview's variables, so they are for
 * test values only.
 */

export const MAX_VARS = 50;
export const MAX_VALUE_CHARS = 8 * 1024;

/** Read at runtime, so a key added to the server's settings works after a restart without a rebuild. */
function rawKey() {
  return (process.env["MAYFLY_SECRETS_KEY"] ?? "").trim();
}

export function secretsKeyConfigured(raw = rawKey()) {
  return raw.length >= 32;
}

function keyFrom(raw: string) {
  return createHash("sha256").update(`mayfly-preview-settings:${raw}`).digest();
}

export function encryptValue(plain: string, raw = rawKey()) {
  if (!secretsKeyConfigured(raw)) throw new Error("MAYFLY_SECRETS_KEY is not set.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(raw), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** The plain value, or null when it can't be read (no key, or saved with a different key). */
export function decryptValue(stored: string, raw = rawKey()): string | null {
  if (!secretsKeyConfigured(raw)) return null;
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(raw), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Names that would change how the preview runs or how Docker itself behaves (the Docker command line reads the
// values from its own environment), or that Mayfly sets.
const RESERVED = new Set(["PORT", "HOST", "HOSTNAME", "PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "NO_PROXY", "GODEBUG", "GOGC", "GOMAXPROCS", "GOMEMLIMIT", "GOTRACEBACK", "GOFLAGS"]);
const RESERVED_PREFIXES = ["DOCKER_", "BUILDKIT_", "COMPOSE_", "PREVIEW_", "MAYFLY_", "LD_", "DYLD_", "SSL_CERT_", "XDG_"];

/** Why a name can't be used, or null when it can. */
export function nameProblem(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `"${name.slice(0, 40)}" isn't a valid name. Use letters, numbers and _, not starting with a number.`;
  }
  const upper = name.toUpperCase();
  if (RESERVED.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || upper.endsWith("_PROXY")) {
    return `${name} is set by Mayfly or Docker, so it can't be changed here.`;
  }
  return null;
}

export type VarInput = { name: string; value?: string; build?: boolean };
export type SettingsInput = { size?: PreviewSize; vars: VarInput[] };

/**
 * Check a save from the settings page. A variable sent without a value keeps the value it already has (the page
 * never sees values); one left out is removed.
 */
export function applySettingsUpdate(
  raw: unknown,
  existing: RepoSettings | undefined,
  options: { now?: string; key?: string } = {},
): { ok: true; settings: RepoSettings } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Send the settings as JSON." };
  const body = raw as Record<string, unknown>;
  const size = body.size === undefined || body.size === null ? "standard" : body.size;
  if (!isPreviewSize(size)) return { ok: false, error: "Choose Small, Standard or Large." };
  const list = Array.isArray(body.vars) ? body.vars : [];
  if (list.length > MAX_VARS) return { ok: false, error: `Keep it to ${MAX_VARS} variables per repository.` };

  const now = options.now ?? new Date().toISOString();
  const key = options.key ?? rawKey();
  const seen = new Set<string>();
  const vars: StoredVar[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each variable needs a name." };
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const problem = nameProblem(name);
    if (problem) return { ok: false, error: problem };
    if (seen.has(name.toUpperCase())) return { ok: false, error: `${name} is listed twice.` };
    seen.add(name.toUpperCase());
    const build = item.build === true;
    if (item.value === undefined || item.value === null) {
      const kept = existing?.vars.find((old) => old.name === name);
      if (!kept) return { ok: false, error: `Enter a value for ${name}.` };
      vars.push({ ...kept, build, updatedAt: kept.build === build ? kept.updatedAt : now });
      continue;
    }
    if (typeof item.value !== "string") return { ok: false, error: `The value for ${name} must be text.` };
    if (item.value.includes("\u0000")) return { ok: false, error: `The value for ${name} has a character that can't be used.` };
    if (item.value.length > MAX_VALUE_CHARS) return { ok: false, error: `The value for ${name} is too long (8 KB at most).` };
    if (!secretsKeyConfigured(key)) {
      return { ok: false, error: "Values can't be saved until MAYFLY_SECRETS_KEY is set on the server." };
    }
    vars.push({ name, value: encryptValue(item.value, key), build, updatedAt: now });
  }

  // Settings the page didn't send stay as they were. Empty or null clears them.
  let productionUrl = existing?.productionUrl;
  if (body.productionUrl !== undefined) {
    if (body.productionUrl === null || (typeof body.productionUrl === "string" && !body.productionUrl.trim())) productionUrl = undefined;
    else {
      productionUrl = cleanProductionUrl(body.productionUrl) ?? undefined;
      if (!productionUrl) return { ok: false, error: "The production address should start with https:// (for example https://example.com)." };
    }
  }
  let smoke = existing?.smoke;
  if (body.smoke !== undefined) {
    const parsed = parseChecks(body.smoke);
    if (!parsed.ok) return parsed;
    smoke = parsed.checks.length > 0 ? parsed.checks : undefined;
  }
  let database = existing?.database;
  if (body.database !== undefined) {
    const parsed = parseDbSettings(body.database, nameProblem);
    if (!parsed.ok) return parsed;
    database = parsed.db ?? undefined;
    if (database) {
      if (seen.has(database.envName.toUpperCase())) {
        return { ok: false, error: `${database.envName} is also listed as a variable. Remove one of them: the database address would overwrite it.` };
      }
      if (!secretFromEnv()) return { ok: false, error: "A sandbox database needs MAYFLY_SECRETS_KEY set on the server (it derives each preview's password)." };
    }
  }
  return {
    ok: true,
    settings: {
      ...(size !== "standard" ? { size } : {}),
      vars,
      ...(productionUrl ? { productionUrl } : {}),
      ...(smoke ? { smoke } : {}),
      ...(database ? { database } : {}),
      updatedAt: now,
    },
  };
}

export type VarView = { name: string; build: boolean; updatedAt: string; readable: boolean };
export type RepoSettingsView = {
  repository: string;
  size: PreviewSize;
  vars: VarView[];
  productionUrl: string | null;
  smoke: SmokeCheck[];
  database: DbSettings | null;
  /** Why the database can't be made on this server yet, or null when it can. */
  databaseProblem: string | null;
  updatedAt: string | null;
};

/** What the settings page sees: names, flags and dates, never values. */
export function settingsView(repository: string, settings: RepoSettings | undefined, key = rawKey()): RepoSettingsView {
  return {
    repository,
    size: settings?.size ?? "standard",
    vars: (settings?.vars ?? []).map((item) => ({
      name: item.name,
      build: item.build,
      updatedAt: item.updatedAt,
      readable: decryptValue(item.value, key) !== null,
    })),
    productionUrl: settings?.productionUrl ?? null,
    smoke: settings?.smoke ?? [],
    database: settings?.database ?? null,
    databaseProblem: settings?.database ? sandboxProblem(settings.database.kind) : null,
    updatedAt: settings?.updatedAt ?? null,
  };
}

export type RepoEnv = {
  runtime: Record<string, string>;
  build: Record<string, string>;
  unreadable: string[];
  /** The kind of sandbox database made for this deploy. */
  sandbox?: DbKind;
};

/** The plain values for one repository's previews. Values that can't be read are left out and named. */
export function envFromSettings(settings: RepoSettings | undefined, key = rawKey()): RepoEnv {
  const out: RepoEnv = { runtime: {}, build: {}, unreadable: [] };
  for (const item of settings?.vars ?? []) {
    const value = decryptValue(item.value, key);
    if (value === null) {
      out.unreadable.push(item.name);
      continue;
    }
    out.runtime[item.name] = value;
    if (item.build) out.build[item.name] = value;
  }
  return out;
}

export function settingsFor(all: PreviewSettings | undefined, repository: string) {
  return all?.[repository.trim().toLowerCase()];
}

/** The repository's sandbox database settings, if it has any. */
export async function repoDatabase(repository: string): Promise<DbSettings | undefined> {
  const state = await loadState();
  return settingsFor(state.previewSettings, repository)?.database;
}

/** Loads the saved settings and returns one repository's plain values, for the deployer and the builder. */
export async function repoEnv(repository: string): Promise<RepoEnv> {
  const state = await loadState();
  const env = envFromSettings(settingsFor(state.previewSettings, repository));
  if (env.unreadable.length) {
    console.error(
      `Preview settings for ${repository}: ${env.unreadable.join(", ")} can't be read (MAYFLY_SECRETS_KEY missing or changed), so previews start without them.`,
    );
  }
  return env;
}
