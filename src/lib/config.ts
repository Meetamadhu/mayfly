export interface OrchestratorConfig {
  maxConcurrent: number;
  ttlMs: number;
  idleMs: number;
  ttlHours: number;
  idleHours: number;
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

export function getConfig(): OrchestratorConfig {
  const ttlHours = positiveNumber("PREVIEW_TTL_HOURS", 8) || 8;
  const idleHours = positiveNumber("PREVIEW_IDLE_HOURS", 4) || 4;
  const maxConcurrent = positiveNumber("MAX_CONCURRENT_ENVIRONMENTS", 10) || 10;
  const sleepSeconds = positiveNumber("PREVIEW_SLEEP_SECONDS", 20) || 20;

  return {
    maxConcurrent,
    ttlHours,
    idleHours,
    ttlMs: ttlHours * 60 * 60 * 1000,
    idleMs: idleHours * 60 * 60 * 1000,
    stuckMs: (positiveNumber("PREVIEW_STUCK_MINUTES", 10) || 10) * 60 * 1000,
    reaperIntervalMs: positiveNumber("REAPER_INTERVAL_MS", 60_000) || 60_000,
    fakeDelayMs: positiveNumber("PREVIEW_FAKE_DELAY_MS", 700),
    sleepSeconds,
    sleepMs: sleepSeconds * 1000,
    deployer: process.env.VERCEL || process.env.DEPLOYER === "fake" ? "fake" : "process",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    githubToken: process.env.GITHUB_TOKEN ?? "",
    previewBaseUrl: previewBase(),
    demo: demoPreview(),
  };
}
