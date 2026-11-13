export interface OrchestratorConfig {
  maxConcurrent: number;
  ttlMs: number;
  idleMs: number;
  ttlHours: number;
  idleHours: number;
  /** Hard cap: expiresAt may never pass createdAt + this. */
  maxLifetimeHours: number;
  maxLifetimeMs: number;
  stuckMs: number;
  reaperIntervalMs: number;
  fakeDelayMs: number;
  sleepMs: number;
  sleepSeconds: number;
  deployer: "process" | "fake";
  webhookSecret: string;
  githubToken: string;
  previewBaseUrl: string;
  demo: { repository: string; prNumber: number } | null;
}

function previewBase() {
  const configured = process.env.PREVIEW_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const render = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  if (render) return render;
  const codespace = process.env.CODESPACE_NAME?.trim();
  const codespaceDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (codespace && codespaceDomain) return `https://${codespace}-3000.${codespaceDomain}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function demoPreview() {
  const raw = process.env.DEMO_PREVIEW?.trim() ?? "";
  const match = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(raw);
  if (!match) return null;
  const prNumber = Number(match[2]);
  if (!Number.isInteger(prNumber) || prNumber > 1_000_000) return null;
  return { repository: match[1].toLowerCase(), prNumber };
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Plain Node unless PREVIEW_RUNTIME=docker. Compose sets docker. Render leaves this unset. */
export function previewRuntime(): "docker" | "process" {
  return (process.env.PREVIEW_RUNTIME ?? "").trim() === "docker" ? "docker" : "process";
}

/** Repositories whose pull requests may be built, from PREVIEW_REPOS (comma-separated owner/name). */
export function previewRepos(): string[] {
  return (process.env.PREVIEW_REPOS ?? "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((item) => /^[\w.-]+\/[\w.-]+$/.test(item));
}

export function repositoryAllowed(repository: string) {
  return previewRepos().includes(repository.trim().toLowerCase());
}

/**
 * Docker previews build each pull request's own Dockerfile. Process mode and the fake deployer keep the
 * placeholder app, and so does the demo preview.
 */
export function buildsPullRequests() {
  return previewRuntime() === "docker" && !(process.env.VERCEL || process.env.DEPLOYER === "fake");
}

/** A build may take 10 minutes, so a preview is not stuck before that. */
export const BUILD_LIMIT_MS = 10 * 60 * 1000;

function limitInteger(name: string, fallback: number, min: number, max: number) {
  const text = (process.env[name] ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

function limitMemory(name: string, fallback: string, minMb: number, maxMb: number) {
  const match = /^(\d+)([mg])$/.exec((process.env[name] ?? "").trim().toLowerCase());
  if (!match) return fallback;
  const megabytes = Number(match[1]) * (match[2] === "g" ? 1024 : 1);
  return megabytes >= minMb && megabytes <= maxMb ? `${match[1]}${match[2]}` : fallback;
}

function limitCpus(name: string, fallback: number, min: number, max: number) {
  const text = (process.env[name] ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

/** Limits on building pull requests. A bad value falls back to the default. */
export function buildLimits() {
  return {
    /** Builds that run at once. Others wait their turn. */
    maxBuilds: limitInteger("PREVIEW_MAX_BUILDS", 1, 1, 8),
    /** Memory (swap included) for each build step, 256m to 4g. */
    memory: limitMemory("PREVIEW_BUILD_MEMORY", "1g", 256, 4096),
    /** CPUs for each build step, 0.25 to 4. */
    cpus: limitCpus("PREVIEW_BUILD_CPUS", 1, 0.25, 4),
    /** The clone and the build context, in MB. */
    maxRepoMb: limitInteger("PREVIEW_MAX_REPO_MB", 200, 10, 5000),
    /** The built image, in MB. */
    maxImageMb: limitInteger("PREVIEW_MAX_IMAGE_MB", 1024, 50, 10000),
  };
}

/** Assumed cost of one preview container running for an hour. */
export function previewCostPerHour() {
  return positiveNumber("PREVIEW_COST_PER_HOUR", 0.05) || 0.05;
}

let sleepRulesCacheKey: string | null = null;
let sleepRulesCache = new Map<string, number>();

/**
 * Parse PREVIEW_SLEEP_RULES="owner/name=60,other/repo=300". Invalid entries are skipped with a warning.
 * Repos not listed use PREVIEW_SLEEP_SECONDS.
 */
export function parseSleepRules(raw = process.env.PREVIEW_SLEEP_RULES ?? ""): Map<string, number> {
  if (raw === sleepRulesCacheKey) return sleepRulesCache;
  const next = new Map<string, number>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const match = /^([\w.-]+\/[\w.-]+)=(\d+)$/.exec(entry);
    if (!match) {
      console.warn(`Ignoring invalid PREVIEW_SLEEP_RULES entry: ${entry}`);
      continue;
    }
    const seconds = Number(match[2]);
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.warn(`Ignoring invalid PREVIEW_SLEEP_RULES entry: ${entry}`);
      continue;
    }
    next.set(match[1].toLowerCase(), seconds);
  }
  sleepRulesCacheKey = raw;
  sleepRulesCache = next;
  return next;
}

/** Idle seconds for this repository: per-repo rule, else PREVIEW_SLEEP_SECONDS. */
export function sleepSecondsForRepo(repository: string): number {
  const rules = parseSleepRules();
  const key = repository.trim().toLowerCase();
  return rules.get(key) ?? getConfig().sleepSeconds;
}

export function getConfig(): OrchestratorConfig {
  const ttlHours = positiveNumber("PREVIEW_TTL_HOURS", 8) || 8;
  const idleHours = positiveNumber("PREVIEW_IDLE_HOURS", 4) || 4;
  const maxLifetimeHours = positiveNumber("PREVIEW_MAX_LIFETIME_HOURS", 168) || 168;
  const maxConcurrent = positiveNumber("MAX_CONCURRENT_ENVIRONMENTS", 10) || 10;
  const sleepSeconds = positiveNumber("PREVIEW_SLEEP_SECONDS", 20) || 20;
  // Warn about bad rules once at config load / first use.
  parseSleepRules();

  return {
    maxConcurrent,
    ttlHours,
    idleHours,
    maxLifetimeHours,
    maxLifetimeMs: maxLifetimeHours * 60 * 60 * 1000,
    ttlMs: ttlHours * 60 * 60 * 1000,
    idleMs: idleHours * 60 * 60 * 1000,
    stuckMs: Math.max(
      (positiveNumber("PREVIEW_STUCK_MINUTES", 10) || 10) * 60 * 1000,
      buildsPullRequests() ? BUILD_LIMIT_MS + 2 * 60 * 1000 : 0,
    ),
    reaperIntervalMs: positiveNumber("REAPER_INTERVAL_MS", 60_000) || 60_000,
    fakeDelayMs: positiveNumber("PREVIEW_FAKE_DELAY_MS", 700),
    sleepSeconds,
    sleepMs: sleepSeconds * 1000,
    deployer: process.env.VERCEL || process.env.DEPLOYER === "fake" ? "fake" : "process",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    // Repo secrets cannot be named GITHUB_*; Codespaces/Actions use MAYFLY_GITHUB_TOKEN.
    githubToken: (process.env.GITHUB_TOKEN ?? process.env.MAYFLY_GITHUB_TOKEN ?? "").trim(),
    previewBaseUrl: previewBase(),
    demo: demoPreview(),
  };
}
