import { isPreviewSize, type PreviewSize } from "./sizes";
import { asStoredChecks, type SmokeCheck } from "./smoke";
import { asStoredDb, type DbSettings } from "./sandbox-db";
import { cleanProductionUrl } from "./visual-diff";

/**
 * How preview settings are saved in Mayfly's state (JSON file or MongoDB). Values are encrypted (see
 * preview-settings.ts); this file only checks the shape, so a damaged entry is dropped instead of breaking a load.
 */

export interface StoredVar {
  name: string;
  /** "v1.<iv>.<tag>.<data>", base64url parts, AES-256-GCM. Never the plain value. */
  value: string;
  /** Also passed to the build (--build-arg), for values the app needs while building, such as NEXT_PUBLIC_ ones. */
  build: boolean;
  updatedAt: string;
}

export interface RepoSettings {
  /** The size for this repository's previews opened from GitHub. Absent means Standard. */
  size?: PreviewSize;
  vars: StoredVar[];
  /** The live site to compare each preview with (screenshots side by side). */
  productionUrl?: string;
  /** Pages to check once a preview is ready. Absent means the home page should answer 200. */
  smoke?: SmokeCheck[];
  /** A sandbox database for each preview. */
  database?: DbSettings;
  updatedAt: string;
}

/** Keyed by repository, lower case ("owner/name"). */
export type PreviewSettings = Record<string, RepoSettings>;

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function asVar(value: unknown): StoredVar | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !NAME_PATTERN.test(raw.name)) return null;
  if (typeof raw.value !== "string" || !raw.value.startsWith("v1.")) return null;
  return {
    name: raw.name,
    value: raw.value,
    build: raw.build === true,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function asStoredSettings(value: unknown): PreviewSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: PreviewSettings = {};
  for (const [repository, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!REPO_PATTERN.test(repository) || !entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const vars = Array.isArray(raw.vars) ? raw.vars.map(asVar).filter((item): item is StoredVar => item !== null) : [];
    const productionUrl = cleanProductionUrl(raw.productionUrl);
    const smoke = asStoredChecks(raw.smoke);
    const database = asStoredDb(raw.database);
    out[repository.toLowerCase()] = {
      ...(isPreviewSize(raw.size) && raw.size !== "standard" ? { size: raw.size } : {}),
      vars,
      ...(productionUrl ? { productionUrl } : {}),
      ...(smoke ? { smoke } : {}),
      ...(database ? { database } : {}),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    };
  }
  return Object.keys(out).length ? out : undefined;
}
