export interface OrchestratorConfig {
  maxConcurrent: number;
  ttlMs: number;
  idleMs: number;
  ttlHours: number;
  idleHours: number;
  stuckMs: number;
  reaperIntervalMs: number;
  fakeDelayMs: number;
  webhookSecret: string;
  githubToken: string;
  previewBaseUrl: string;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export function getConfig(): OrchestratorConfig {
  const ttlHours = positiveNumber("PREVIEW_TTL_HOURS", 8) || 8;
  const idleHours = positiveNumber("PREVIEW_IDLE_HOURS", 4) || 4;
  const maxConcurrent = positiveNumber("MAX_CONCURRENT_ENVIRONMENTS", 5) || 5;

  return {
    maxConcurrent,
    ttlHours,
    idleHours,
    ttlMs: ttlHours * 60 * 60 * 1000,
    idleMs: idleHours * 60 * 60 * 1000,
    stuckMs: (positiveNumber("PREVIEW_STUCK_MINUTES", 10) || 10) * 60 * 1000,
    reaperIntervalMs: positiveNumber("REAPER_INTERVAL_MS", 60_000) || 60_000,
    fakeDelayMs: positiveNumber("PREVIEW_FAKE_DELAY_MS", 700),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    githubToken: process.env.GITHUB_TOKEN ?? "",
    previewBaseUrl: (process.env.PREVIEW_BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
  };
}
