export type EnvironmentStatus =
  | "provisioning"
  | "ready"
  | "updating"
  | "destroying"
  | "destroyed"
  | "failed";

export type DestroyReason = "closed" | "merged" | "idle" | "expired" | "manual" | "stuck" | "failed" | "budget";

export type LifecycleAction =
  | "created"
  | "updated"
  | "destroyed"
  | "unchanged"
  | "idle-marked"
  | "activity"
  | "slept"
  | "keep_awake"
  | "keep_awake_off"
  | "labels";

export interface PreviewComment {
  at: string;
  body: string;
}

/** Lifecycle timeline entry for a preview. Keep the last 50 on the environment. */
export interface EnvironmentEvent {
  at: string;
  type: string;
  detail?: string;
}

export type SleepState = "awake" | "waking" | "asleep" | "unknown";

export interface Environment {
  id: string;
  /** Whether the preview app is running. Read from the gate without waking it. */
  sleep?: SleepState;
  repository: string;
  prNumber: number;
  sha: string;
  branch: string;
  status: EnvironmentStatus;
  deploymentId: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastActiveAt: string;
  destroyedAt: string | null;
  destroyReason: DestroyReason | null;
  error: string | null;
  updateGeneration: number;
  comments: PreviewComment[];
  /** GitHub issue comment id for the single Mayfly preview comment on this PR. */
  githubCommentId?: number | null;
  /** Wall time from deploy start to ready, in milliseconds. */
  buildMs?: number | null;
  /** Last wake duration from the gate, in milliseconds. Overview-only; not persisted. */
  lastWakeMs?: number | null;
  /** Lifecycle timeline; newest entries at the end. Keep the last 50. */
  events?: EnvironmentEvent[];
  /** Estimated awake/asleep time for this preview (demo excluded). Absent on older previews. */
  usage?: PreviewUsage;
  /** Size chosen when an admin started the preview by hand. Absent means Standard. */
  size?: import("./sizes").PreviewSize;
  /** Remove the preview once its awake time has cost this much (in the configured currency). */
  budget?: number | null;
  /** When set and in the future, the gate will not idle-sleep this preview. */
  keepAwakeUntil?: string | null;
  /** Effective idle seconds for this repo (overview-only; from the TTL policies / env defaults). */
  sleepSeconds?: number;
  /** Label names on the pull request, from the latest GitHub event that carried them. */
  labels?: string[];
  /** GitHub login of whoever opened the pull request. Absent for simulator previews. */
  author?: string;
  /** The pull request's title, as of the last event Mayfly received. Absent for older previews. */
  title?: string;
  /** Overview-only: the pull request carries the keep label, so this preview does not expire while it is open. */
  keptByLabel?: boolean;
  /** How many times this preview has been extended. */
  extensions?: number;
  /** The expiry time an expiry warning was already posted for, so it is posted once per expiry. */
  warnedFor?: string | null;
}

/** Per-preview estimated awake/asleep accumulators. */
export interface PreviewUsage {
  awakeSeconds: number;
  asleepSeconds: number;
}

export interface DeploymentRecord {
  deploymentId: string;
  repository: string;
  prNumber: number;
  sha: string;
  branch: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  port?: number;
  /** The image this preview runs. Set only for built pull requests. */
  image?: string;
}

export interface PullRequestEvent {
  action: "opened" | "synchronize" | "closed" | "reopened" | "labeled" | "unlabeled";
  /** Label names on the pull request, when the event carried them. */
  labels?: string[];
  /** GitHub login of the pull request's author, when the event carried it. */
  author?: string;
  /** The pull request's title, when the event carried it. */
  title?: string;
  repository: string;
  prNumber: number;
  sha: string;
  branch: string;
  merged?: boolean;
  ttlMinutes?: number;
  /** Only for previews an admin starts by hand: their size and budget. */
  size?: import("./sizes").PreviewSize;
  budget?: number;
  /** Repository the pull request's head lives in. A value that differs from `repository` is a fork. */
  headRepository?: string;
}

export interface OrchestratorConfigView {
  maxConcurrent: number;
  ttlHours: number;
  idleHours: number;
  sleepSeconds: number;
  reaperIntervalMs: number;
  previewBaseUrl: string;
  deployer: "process" | "fake";
  webhookVerification: "signed" | "open-in-development";
  demo: string | null;
  /** PREVIEW_PASSWORD is set: preview links ask for the team password. */
  privatePreviews?: boolean;
  /** Repositories PREVIEW_REPOS allows to be built. Null when any repository can open a placeholder preview. */
  allowedRepositories: string[] | null;
  /** True when Mayfly runs on Render, where settings live in the Render dashboard. */
  onRender: boolean;
  /** True when GITHUB_TOKEN or MAYFLY_GITHUB_TOKEN is set. Never includes the token. */
  githubConnected: boolean;
  /** Currency symbol for estimated savings (from PREVIEW_CURRENCY). */
  currency: string;
  /** The TTL policy in effect (page settings over env defaults). */
  policy: {
    ttlHours: number;
    sleepSeconds: number;
    maxLifetimeHours: number;
    maxExtensions: number | null;
    maxPerAuthor: number | null;
    keepLabel: string;
    warnMinutes: number;
  };
}

/** One UTC day's estimated awake/asleep totals. */
export interface UsageDay {
  awakeSeconds: number;
  asleepSeconds: number;
  /** The same time weighted by each preview's size, for money. Absent on totals saved before sizes existed. */
  awakeWeighted?: number;
  asleepWeighted?: number;
}

/** Accumulators for preview awake/asleep time in the current calendar month (UTC). */
export interface UsageMonth {
  month: string;
  asleepSeconds: number;
  awakeSeconds: number;
  /** Weighted by size, for money (see UsageDay). */
  awakeWeighted?: number;
  asleepWeighted?: number;
  lastSampleAt: string;
  /** Daily totals keyed by UTC YYYY-MM-DD; keep the last 31 days. */
  days?: Record<string, UsageDay>;
}

export interface Overview {
  environments: Environment[];
  deployments: DeploymentRecord[];
  config: OrchestratorConfigView;
  summary: {
    live: number;
    destroyed: number;
    failed: number;
    awake: number;
    waking: number;
    asleep: number;
  };
  usage: UsageMonth;
  costPerHour: number;
  /** asleepSeconds/3600 * costPerHour for the current month. */
  savedEstimate: number;
  /** Currency symbol for savedEstimate display. */
  currency: string;
}

export type LifecycleResult =
  | { ok: true; action: LifecycleAction; environment: Environment }
  | {
      ok: false;
      code: "cap" | "author_cap" | "not_found" | "invalid" | "conflict" | "deploy_failed";
      error: string;
      environment?: Environment;
    };

export interface ReapResult {
  ok: true;
  destroyed: Environment[];
  failed: { id: string; error: string }[];
}

const LIVE_STATUSES = new Set<EnvironmentStatus>([
  "provisioning",
  "ready",
  "updating",
  "destroying",
]);

export function isLiveStatus(status: EnvironmentStatus): boolean {
  return LIVE_STATUSES.has(status);
}
