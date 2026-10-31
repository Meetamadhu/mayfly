import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { getDeployer, previewUrl, publicPreviewUrl, type Deployment } from "./deployer";
import { publishPullRequestComment } from "./http";
import { exclusive, loadState, saveState } from "./store";
import {
  isLiveStatus,
  type DeploymentRecord,
  type DestroyReason,
  type Environment,
  type LifecycleResult,
  type Overview,
  type PullRequestEvent,
  type ReapResult,
  type SleepState,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

function ttlMsFor(event: PullRequestEvent) {
  const config = getConfig();
  if (event.ttlMinutes === undefined) return config.ttlMs;
  return event.ttlMinutes * 60 * 1000;
}

function findLive(environments: Environment[], repository: string, prNumber: number) {
  return environments.find(
    (env) => env.repository === repository && env.prNumber === prNumber && isLiveStatus(env.status),
  );
}

function readyComment(env: Environment, refreshed: boolean) {
  const verb = refreshed ? "updated" : "ready";
  return `Preview ${verb}: ${env.url}\nCommit \`${env.sha}\`. Expires ${env.expiresAt}. It is removed when the pull request closes or it reaches its time limit. When nobody is using it, the app sleeps and wakes on the next visit.`;
}

function destroyedComment(env: Environment) {
  return `Preview destroyed (${env.destroyReason}). The deployment is gone.`;
}

async function commentQuietly(env: Environment, body: string) {
  try {
    await publishPullRequestComment(env.repository, env.prNumber, body);
  } catch (error) {
    console.error("Pull request comment failed", error);
  }
}

function normalizeEvent(event: PullRequestEvent): PullRequestEvent {
  return {
    ...event,
    repository: event.repository.trim().toLowerCase(),
    sha: event.sha.trim().toLowerCase(),
    branch: event.branch.trim(),
  };
}

function expectedPreviewUrl(repository: string, prNumber: number) {
  return getConfig().deployer === "fake" ? previewUrl(repository, prNumber) : publicPreviewUrl(repository, prNumber);
}

function previewUrlIsCurrent(current: string, next: string) {
  try {
    const left = new URL(current);
    const right = new URL(next);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

function refreshPreviewUrl(env: Environment): Environment {
  if (!env.url) return env;
  const next = expectedPreviewUrl(env.repository, env.prNumber);
  // A saved link from another port, such as a stopped test server, would not open on this machine.
  const stale =
    env.url.includes(".preview.local") ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(env.url) ||
    !previewUrlIsCurrent(env.url, next);
  if (!stale || env.url === next) return env;
  const previous = env.url;
  return {
    ...env,
    url: next,
    comments: env.comments.map((comment) => ({
      ...comment,
      body: comment.body.split(previous).join(next),
    })),
  };
}

export async function getPreview(repository: string, prNumber: number) {
  const normalized = repository.trim().toLowerCase();
  const [state, deployments] = await Promise.all([
    exclusive(async () => loadState()),
    getDeployer().list(),
  ]);
  const matches = state.environments
    .filter((env) => env.repository === normalized && env.prNumber === prNumber)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const environment = matches.find((env) => isLiveStatus(env.status)) ?? matches[0] ?? null;
  const deployment = deployments.find((item) => item.repository === normalized && item.prNumber === prNumber) ?? null;
  return {
    environment: environment ? refreshPreviewUrl(environment) : null,
    deployment,
  };
}

/**
 * Ask the preview gate whether its app is running. The gate answers this path itself
 * and never boots the app or touches its idle clock, so polling does not wake a preview.
 * The port comes from the deployment record, never from a request URL.
 */
async function readSleep(env: Environment, deployments: DeploymentRecord[]): Promise<SleepState> {
  if (getConfig().deployer === "fake") return "unknown";
  if (!isLiveStatus(env.status) || !env.deploymentId) return "unknown";
  const port = deployments.find((item) => item.deploymentId === env.deploymentId)?.port;
  if (!port) return "unknown";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { state?: unknown };
    return body.state === "awake" || body.state === "waking" || body.state === "asleep" ? body.state : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Where the public preview path forwards to. The port comes only from the deployment record that matches
 * a live environment for this repository and pull request; nothing from the request URL is used as a target.
 */
export async function findProxyTarget(
  repository: string,
  prNumber: number,
): Promise<{ envId: string; port: number } | null> {
  const normalized = repository.trim().toLowerCase();
  const [state, deployments] = await Promise.all([
    exclusive(async () => loadState()),
    getDeployer().list(),
  ]);
  const env = state.environments.find(
    (item) =>
      item.repository === normalized &&
      item.prNumber === prNumber &&
      (item.status === "ready" || item.status === "updating") &&
      item.deploymentId,
  );
  if (!env) return null;
  const deployment = deployments.find((item) => item.deploymentId === env.deploymentId);
  const port = deployment?.port;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { envId: env.id, port };
}

export async function getOverview(): Promise<Overview> {
  const config = getConfig();
  const [state, deployments] = await Promise.all([
    exclusive(async () => loadState()),
    getDeployer().list(),
  ]);

  const sorted = state.environments.map(refreshPreviewUrl).sort((a, b) => {
    const liveRank = Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status));
    if (liveRank !== 0) return liveRank;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const environments: Environment[] = await Promise.all(
    sorted.map(async (env) => ({ ...env, sleep: await readSleep(env, deployments) })),
  );

  return {
    environments,
    deployments: deployments.map((item) => {
      const next = expectedPreviewUrl(item.repository, item.prNumber);
      return previewUrlIsCurrent(item.url, next) ? item : { ...item, url: next };
    }),
    config: {
      maxConcurrent: config.maxConcurrent,
      ttlHours: config.ttlHours,
      idleHours: config.idleHours,
      sleepSeconds: config.sleepSeconds,
      reaperIntervalMs: config.reaperIntervalMs,
      previewBaseUrl: config.previewBaseUrl,
      deployer: config.deployer,
      webhookVerification: config.webhookSecret ? "signed" : "open-in-development",
      demo: config.demo ? `${config.demo.repository}#${config.demo.prNumber}` : null,
    },
    summary: {
      live: environments.filter((env) => isLiveStatus(env.status)).length,
      destroyed: environments.filter((env) => env.status === "destroyed").length,
      failed: environments.filter((env) => env.status === "failed").length,
      awake: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "awake").length,
      waking: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "waking").length,
      asleep: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "asleep").length,
    },
  };
}

export async function getEnvironment(id: string): Promise<Environment | null> {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    return env ? clone(env) : null;
  });
}

async function applyDeployment(
  envId: string,
  generation: number,
  deployment: Deployment,
  comment: (env: Environment) => string,
): Promise<{ stale: boolean; environment: Environment | null; commentBody?: string }> {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    if (!env || env.updateGeneration !== generation || env.status === "destroying" || env.status === "destroyed") {
      return { stale: true, environment: env ? clone(env) : null };
    }

    const now = iso();
    const refreshed = env.status === "updating";
    env.status = "ready";
    env.deploymentId = deployment.deploymentId;
    env.url = deployment.url;
    env.error = null;
    env.updatedAt = now;
    const body = comment(env);
    if (refreshed) {
      env.comments.push({ at: now, body });
    } else {
      env.comments.push({ at: now, body: readyComment(env, false) });
    }
    await saveState(state);
    return { stale: false, environment: clone(env), commentBody: env.comments.at(-1)?.body };
  });
}

async function markDeployFailed(envId: string, generation: number, message: string) {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    if (!env || env.updateGeneration !== generation) return env ? clone(env) : null;
    env.status = "failed";
    env.error = message;
    env.updatedAt = iso();
    await saveState(state);
    return clone(env);
  });
}

async function runDeploy(
  env: Environment,
  work: () => Promise<Deployment>,
  action: "created" | "updated",
): Promise<LifecycleResult> {
  const generation = env.updateGeneration;
  let deployment: Deployment;
  try {
    deployment = await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deploy failed";
    const failed = await markDeployFailed(env.id, generation, message);
    return {
      ok: false,
      code: "deploy_failed",
      error: message,
      environment: failed ?? undefined,
    };
  }

  const applied = await applyDeployment(env.id, generation, deployment, (current) => readyComment(current, true));
  if (applied.stale) {
    await getDeployer().destroy({ deploymentId: deployment.deploymentId }).catch((error) => {
      console.error("Failed to roll back a stale deployment", error);
    });
    if (!applied.environment) {
      return { ok: false, code: "not_found", error: "Environment disappeared during deploy." };
    }
    return { ok: true, action: "unchanged", environment: applied.environment };
  }

  if (applied.environment && applied.commentBody) {
    await commentQuietly(applied.environment, applied.commentBody);
  }

  return { ok: true, action, environment: applied.environment as Environment };
}

async function reserve(event: PullRequestEvent): Promise<LifecycleResult> {
  const normalized = normalizeEvent(event);
  return exclusive(async () => {
    const state = await loadState();
    const existing = findLive(state.environments, normalized.repository, normalized.prNumber);
    const now = iso();
    const expiresAt = iso(Date.now() + ttlMsFor(normalized));

    if (existing) {
      if (existing.status === "provisioning" || existing.status === "destroying") {
        return {
          ok: false,
          code: "conflict",
          error: "This preview is busy. Retry in a moment.",
          environment: clone(existing),
        };
      }

      existing.status = "updating";
      existing.sha = normalized.sha;
      existing.branch = normalized.branch;
      existing.updatedAt = now;
      existing.lastActiveAt = now;
      existing.expiresAt = expiresAt;
      existing.error = null;
      existing.updateGeneration += 1;
      await saveState(state);
      return { ok: true, action: "updated", environment: clone(existing) };
    }

    const config = getConfig();
    const live = state.environments.filter((env) => isLiveStatus(env.status)).length;
    if (live >= config.maxConcurrent) {
      return {
        ok: false,
        code: "cap",
        error: `At the live limit of ${config.maxConcurrent}. Close a pull request or wait for the reaper.`,
      };
    }

    const created: Environment = {
      id: randomUUID(),
      repository: normalized.repository,
      prNumber: normalized.prNumber,
      sha: normalized.sha,
      branch: normalized.branch,
      status: "provisioning",
      deploymentId: null,
      url: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      lastActiveAt: now,
      destroyedAt: null,
      destroyReason: null,
      error: null,
      updateGeneration: 1,
      comments: [],
    };
    state.environments.push(created);
    await saveState(state);
    return { ok: true, action: "created", environment: clone(created) };
  });
}

function startDeploy(environment: Environment, action: "created" | "updated"): Promise<LifecycleResult> {
  const deployer = getDeployer();
  const request = {
    envId: environment.id,
    repository: environment.repository,
    prNumber: environment.prNumber,
    sha: environment.sha,
    branch: environment.branch,
    deploymentId: environment.deploymentId,
  };
  const work = action === "created" ? () => deployer.provision(request) : () => deployer.update(request);
  return runDeploy(environment, work, action);
}

export async function applyPullRequestEvent(
  event: PullRequestEvent,
  options?: { wait?: boolean },
): Promise<LifecycleResult> {
  if (event.action === "closed") {
    const normalized = normalizeEvent(event);
    const existing = await exclusive(async () => {
      const state = await loadState();
      return findLive(state.environments, normalized.repository, normalized.prNumber) ?? null;
    });
    if (!existing) {
      return { ok: false, code: "not_found", error: `No live preview for ${normalized.repository}#${normalized.prNumber}.` };
    }
    return destroyEnvironment(existing.id, normalized.merged ? "merged" : "closed", options);
  }

  const reserved = await reserve(event);
  if (!reserved.ok) return reserved;
  if (reserved.action !== "created" && reserved.action !== "updated") return reserved;

  const pending = startDeploy(reserved.environment, reserved.action);
  if (options?.wait) return pending;
  void pending.catch((error) => console.error("Deploy failed", error));
  return reserved;
}

async function finishDestroy(envId: string, deploymentId: string | null): Promise<Environment> {
  if (deploymentId) {
    try {
      await getDeployer().destroy({ deploymentId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Destroy failed";
      const failed = await exclusive(async () => {
        const state = await loadState();
        const env = state.environments.find((item) => item.id === envId);
        if (!env) return null;
        if (env.status === "destroying") {
          env.error = message;
          env.updatedAt = iso();
          await saveState(state);
        }
        return clone(env);
      });
      if (failed) return failed;
      throw error;
    }
  }

  const finished = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    if (!env) return null;
    if (env.status !== "destroying") return clone(env);
    const now = iso();
    env.status = "destroyed";
    env.destroyedAt = now;
    env.updatedAt = now;
    env.error = null;
    const body = destroyedComment(env);
    env.comments.push({ at: now, body });
    await saveState(state);
    return clone(env);
  });

  if (!finished) {
    throw new Error("Environment disappeared during destroy.");
  }
  const last = finished.comments.at(-1);
  if (finished.status === "destroyed" && last) {
    await commentQuietly(finished, last.body);
  }
  return finished;
}

export async function destroyEnvironment(
  id: string,
  reason: DestroyReason,
  options?: { wait?: boolean },
): Promise<LifecycleResult> {
  const reserved = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false as const, code: "not_found" as const, error: "No environment with that id." };
    if (env.status === "destroyed") {
      return { ok: true as const, action: "unchanged" as const, environment: clone(env) };
    }
    if (env.status === "failed") {
      return {
        ok: false as const,
        code: "conflict" as const,
        error: "This preview already failed.",
        environment: clone(env),
      };
    }
    if (env.status !== "destroying") {
      env.status = "destroying";
      env.destroyReason = reason;
      env.updateGeneration += 1;
      env.error = null;
      env.updatedAt = iso();
      await saveState(state);
    }
    return { ok: true as const, action: "destroyed" as const, environment: clone(env) };
  });

  if (!reserved.ok) return reserved;
  if (reserved.action === "unchanged") return reserved;

  const pending = finishDestroy(reserved.environment.id, reserved.environment.deploymentId);
  if (options?.wait) {
    const environment = await pending;
    if (environment.status === "failed" || environment.status === "destroying") {
      return {
        ok: false,
        code: "deploy_failed",
        error: environment.error ?? "Destroy did not finish.",
        environment,
      };
    }
    return { ok: true, action: "destroyed", environment };
  }

  void pending.catch((error) => console.error("Destroy failed", error));
  return reserved;
}

function isDemo(env: Environment) {
  const demo = getConfig().demo;
  return Boolean(demo && env.repository === demo.repository && env.prNumber === demo.prNumber);
}

/** Ask the gate on this machine to stop the app. The public /p/ proxy is not used. */
export async function sleepEnvironment(id: string): Promise<LifecycleResult> {
  const located = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false as const, code: "not_found" as const, error: "No environment with that id." };
    if (env.status !== "ready" && env.status !== "updating") {
      return {
        ok: false as const,
        code: "conflict" as const,
        error: "Only a live preview can be put to sleep.",
        environment: clone(env),
      };
    }
    return { ok: true as const, environment: clone(env) };
  });
  if (!located.ok) return located;

  const deployments = await getDeployer().list();
  const port = deployments.find((item) => item.deploymentId === located.environment.deploymentId)?.port;
  if (!port) {
    return {
      ok: false,
      code: "conflict",
      error: "This preview has no process to sleep.",
      environment: located.environment,
    };
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_sleep`, { method: "POST", cache: "no-store" });
    if (!response.ok) {
      return { ok: false, code: "deploy_failed", error: "The preview did not sleep.", environment: located.environment };
    }
  } catch {
    return { ok: false, code: "deploy_failed", error: "The preview did not sleep.", environment: located.environment };
  }
  return { ok: true, action: "slept", environment: located.environment };
}

async function ensureDemo() {
  const demo = getConfig().demo;
  if (!demo) return;
  try {
    const state = await loadState();
    const live = state.environments.some(
      (env) => env.repository === demo.repository && env.prNumber === demo.prNumber && isLiveStatus(env.status),
    );
    if (live) return;
    await applyPullRequestEvent(
    {
      action: "opened",
      repository: demo.repository,
      prNumber: demo.prNumber,
      sha: "d3m0d3m0",
      branch: "demo",
    },
      { wait: true },
    );
  } catch (error) {
    console.error("Demo preview was not created", error);
  }
}

export async function recordActivity(id: string): Promise<LifecycleResult> {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false, code: "not_found", error: "No environment with that id." };
    if (env.status !== "ready" && env.status !== "updating") {
      return {
        ok: false,
        code: "conflict",
        error: "Activity is only recorded for a live preview.",
        environment: clone(env),
      };
    }
    const now = iso();
    env.lastActiveAt = now;
    env.updatedAt = now;
    await saveState(state);
    return { ok: true, action: "activity", environment: clone(env) };
  });
}

export async function reap(): Promise<ReapResult> {
  const config = getConfig();
  const now = Date.now();
  const due = await exclusive(async () => {
    const state = await loadState();
    const targets: { id: string; reason: DestroyReason }[] = [];
    for (const env of state.environments) {
      const age = now - Date.parse(env.updatedAt);
      if (env.status === "provisioning" || env.status === "updating" || env.status === "destroying") {
        if (age > config.stuckMs) targets.push({ id: env.id, reason: "stuck" });
        continue;
      }
      if (env.status !== "ready") continue;
      // Idle previews are not destroyed here. The gate sleeps an unused app (the app process exits, the gate
      // stays up) and the next visit wakes it. Only the time limit ends a ready preview.
      if (isDemo(env)) continue;
      if (now >= Date.parse(env.expiresAt)) targets.push({ id: env.id, reason: "expired" });
    }
    return targets;
  });

  const destroyed: Environment[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const target of due) {
    const result = await destroyEnvironment(target.id, target.reason, { wait: true });
    if (result.ok && result.environment.status === "destroyed") destroyed.push(result.environment);
    else if (!result.ok) failed.push({ id: target.id, error: result.error });
  }
  await ensureDemo();
  return { ok: true, destroyed, failed };
}
