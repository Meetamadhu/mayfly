export type EnvironmentStatus =
  | "provisioning"
  | "ready"
  | "updating"
  | "destroying"
  | "destroyed"
  | "failed";

export type DestroyReason = "closed" | "merged" | "idle" | "expired" | "manual" | "stuck";

export type LifecycleAction =
  | "created"
  | "updated"
  | "destroyed"
  | "unchanged"
  | "idle-marked"
  | "activity";

export interface PreviewComment {
  at: string;
  body: string;
}

export interface Environment {
  id: string;
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
}

export interface PullRequestEvent {
  action: "opened" | "synchronize" | "closed" | "reopened";
  repository: string;
  prNumber: number;
  sha: string;
  branch: string;
  merged?: boolean;
  ttlMinutes?: number;
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
}

export interface Overview {
  environments: Environment[];
  deployments: DeploymentRecord[];
  config: OrchestratorConfigView;
  summary: {
    live: number;
    destroyed: number;
    failed: number;
  };
}

export type LifecycleResult =
  | { ok: true; action: LifecycleAction; environment: Environment }
  | {
      ok: false;
      code: "cap" | "not_found" | "invalid" | "conflict" | "deploy_failed";
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
