import { previewsProtected } from "./preview-access";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { imageTag, isBuilding } from "./builder";
import {
  buildsPullRequests,
  getConfig,
  githubConfigured,
  previewCostPerHour,
  previewCurrency,
  previewRepos,
  parseSleepRules,
  previewRuntime,
  sleepSecondsForRepo,
  ttlHoursForRepo,
} from "./config";
import { removedBecause, withoutVisitNearWake } from "./timeline";
import { getDeployer, previewUrl, publicPreviewUrl, type Deployment } from "./deployer";
import { pruneEnvironments } from "./prune";
import { sendAlert } from "./alerts";
import { postPullRequestNote, publishCommitStatus, publishPullRequestComment } from "./http";
import {
  currentPolicy,
  hasKeepLabel,
  parsePolicy,
  setCurrentPolicy,
  type PreviewPolicy,
} from "./policy";
import { exclusive, loadState, saveState } from "./store";
import { checkNewPreview, currentPlan, monthHours } from "./plans";
import {
  isLiveStatus,
  type DeploymentRecord,
  type DestroyReason,
  type Environment,
  type EnvironmentEvent,
  type LifecycleResult,
  type Overview,
  type PullRequestEvent,
  type ReapResult,
  type SleepState,
  type UsageDay,
  type UsageMonth,
} from "./types";
import { hourlyRate, moneySeconds, sizeWeight } from "./sizes";
import {
  feedbackId,
  feedbackLink,
  feedbackNote,
  MAX_FEEDBACK_PER_PREVIEW,
  type FeedbackInput,
  type FeedbackItem,
} from "./feedback";

const MAX_ENVIRONMENT_EVENTS = 50;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

/** Append a timeline event and keep only the last 50. */
export function pushEnvironmentEvent(
  env: Environment,
  event: EnvironmentEvent,
): void {
  const next = [...(env.events ?? []), event];
  env.events = next.length > MAX_ENVIRONMENT_EVENTS ? next.slice(-MAX_ENVIRONMENT_EVENTS) : next;
}

function secondsDetail(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0";
  if (ms < 1000) return (ms / 1000).toFixed(1);
  return String(Math.round(ms / 1000));
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() || message.trim();
}

function lastEventAt(env: Environment, type: string): number {
  const events = env.events;
  if (!events?.length) return 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === type) {
      const at = Date.parse(events[i].at);
      return Number.isFinite(at) ? at : 0;
    }
  }
  return 0;
}

function ttlMsFor(event: PullRequestEvent) {
  if (event.ttlMinutes === undefined) return ttlHoursForRepo(event.repository) * 60 * 60 * 1000;
  return event.ttlMinutes * 60 * 1000;
}

/** Labels from a GitHub event, trimmed and capped. Undefined when the event carried none (the simulator). */
function eventLabels(event: PullRequestEvent): string[] | undefined {
  if (!event.labels) return undefined;
  return event.labels.map((name) => name.trim()).filter(Boolean).slice(0, 50);
}

/** Note on the timeline when the keep label is added or removed. */
function noteKeepChange(env: Environment, wasKept: boolean, at: string) {
  const kept = hasKeepLabel(env.labels);
  if (kept === wasKept) return;
  if (kept) {
    pushEnvironmentEvent(env, { at, type: "kept", detail: currentPolicy().keepLabel });
  } else {
    // Without the label, the normal lifetime starts again from now so the preview is not removed at once.
    env.expiresAt = iso(Math.max(Date.parse(env.expiresAt), Date.parse(at) + ttlHoursForRepo(env.repository) * 3_600_000));
    env.warnedFor = null;
    pushEnvironmentEvent(env, { at, type: "unkept" });
  }
}

function findLive(environments: Environment[], repository: string, prNumber: number) {
  return environments.find(
    (env) => env.repository === repository && env.prNumber === prNumber && isLiveStatus(env.status),
  );
}

function lastUpdatedLine(at = iso()) {
  return `Last updated ${formatUtc(at)}.`;
}

function sleepWords(seconds: number) {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** The lifetime line: a readable expiry, or why there is none. */
function lifetimeLine(env: Environment) {
  const label = currentPolicy().keepLabel;
  if (isDemo(env)) return "This demo preview doesn't expire.";
  if (hasKeepLabel(env.labels)) {
    return `Kept open by the \`${label}\` label until the pull request is closed or merged.`;
  }
  const keep = label ? ` To keep it longer, add the \`${label}\` label.` : "";
  return `Expires ${formatUtc(env.expiresAt)}.${keep}`;
}

/** A table cell's text: pipes and line breaks would break the Markdown table. */
function cell(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function readyComment(env: Environment, refreshed: boolean) {
  const verb = refreshed ? "updated" : "ready";
  const build =
    typeof env.buildMs === "number" && env.buildMs >= 0 ? ` · built in ${formatDurationMs(env.buildMs)}` : "";
  const at = iso();
  return [
    `### Mayfly preview ${verb}`,
    "",
    env.url ? `**[Open preview](${env.url})**` : "Preview URL is not available yet.",
    "",
    "| | |",
    "| --- | --- |",
    env.url ? `| **Preview** | ${env.url} |` : "| **Preview** | The link is not available yet. |",
    `| **Commit** | \`${env.sha.slice(0, 8)}\` on \`${cell(env.branch)}\`${build} |`,
    `| **Lifetime** | ${cell(lifetimeLine(env))} |`,
    `| **Sleep** | Sleeps after ${sleepWords(sleepSecondsForRepo(env.repository))} without visits and wakes on the next one. |`,
    ...feedbackRow(env),
    "",
    `Removed when the pull request is closed or merged. ${lastUpdatedLine(at)}`,
  ].join("\n");
}

/** "Feedback: leave a comment on the preview", when feedback links are on (an admin token is set). */
function feedbackRow(env: Environment) {
  if (!env.url) return [];
  const link = feedbackLink(getConfig().previewBaseUrl, env);
  return link ? [`| **Feedback** | [Mark a spot on the preview and comment](${link}) |`] : [];
}

/**
 * Rewrite the PR comment after something that changes its lifetime line (extend, keep label). Edits the
 * existing comment in place, so nobody is notified. Call outside exclusive().
 */
async function refreshReadyComment(id: string) {
  const env = await exclusive(async () => {
    const state = await loadState();
    const current = state.environments.find((item) => item.id === id);
    if (!current || current.status !== "ready") return null;
    const body = readyComment(current, false);
    current.comments.push({ at: iso(), body });
    await saveState(state);
    return clone(current);
  });
  const body = env?.comments.at(-1)?.body;
  if (env && body) await commentQuietly(env, body);
}

function failedComment(env: Environment, message: string) {
  // The error goes in a code block; a ``` inside it would end the block early.
  const text = message.slice(0, 500).replace(/```/g, "'''");
  return [
    "### Mayfly couldn't build this preview",
    "",
    "```",
    text,
    "```",
    "",
    "| | |",
    "| --- | --- |",
    `| **Commit** | \`${env.sha.slice(0, 8)}\` on \`${cell(env.branch)}\` |`,
    "| **Next** | Fix the problem above and push again; Mayfly will try again on the new commit. |",
    "",
    lastUpdatedLine(),
  ].join("\n");
}

function destroyedComment(env: Environment) {
  const why = env.destroyReason ? ` because ${removedBecause(env.destroyReason)}` : "";
  return [
    "### Mayfly preview removed",
    "",
    `The preview was removed${why}. Its link no longer works.`,
    "",
    lastUpdatedLine(),
  ].join("\n");
}

function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs ? `${mins} min ${secs} s` : `${mins} min`;
}

async function rememberGithubCommentId(envId: string, commentId: number) {
  await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    if (!env || env.githubCommentId === commentId) return;
    env.githubCommentId = commentId;
    await saveState(state);
  });
}

async function commentQuietly(env: Environment, body: string) {
  try {
    const commentId = await publishPullRequestComment(
      env.repository,
      env.prNumber,
      body,
      env.githubCommentId,
    );
    if (typeof commentId === "number") {
      env.githubCommentId = commentId;
      await rememberGithubCommentId(env.id, commentId);
    }
  } catch (error) {
    console.error("Pull request comment failed", error);
  }
}

async function statusQuietly(
  env: Environment,
  input: {
    state: "error" | "failure" | "pending" | "success";
    description: string;
    targetUrl?: string | null;
  },
) {
  try {
    await publishCommitStatus(env.repository, env.sha, {
      state: input.state,
      description: input.description,
      targetUrl: input.targetUrl,
      context: "Mayfly — Preview",
    });
  } catch (error) {
    console.error("Pull request status failed", error);
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

type GateStatus = {
  sleep: SleepState;
  lastWakeMs: number | null;
  sleptAt: string | null;
  wokeAt: string | null;
  /** The idle time the gate is using now. */
  sleepSeconds: number | null;
};

const UNKNOWN_GATE: GateStatus = { sleep: "unknown", lastWakeMs: null, sleptAt: null, wokeAt: null, sleepSeconds: null };

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

/**
 * Ask the preview gate whether its app is running. The gate answers this path itself
 * and never boots the app or touches its idle clock, so polling does not wake a preview.
 * The port comes from the deployment record, never from a request URL.
 */
async function readGate(env: Environment, deployments: DeploymentRecord[]): Promise<GateStatus> {
  if (getConfig().deployer === "fake") return UNKNOWN_GATE;
  if (!isLiveStatus(env.status) || !env.deploymentId) return UNKNOWN_GATE;
  const port = deployments.find((item) => item.deploymentId === env.deploymentId)?.port;
  if (!port) return UNKNOWN_GATE;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return UNKNOWN_GATE;
    const body = (await response.json()) as {
      state?: unknown;
      lastWakeMs?: unknown;
      sleptAt?: unknown;
      wokeAt?: unknown;
      sleepSeconds?: unknown;
    };
    const sleep: SleepState =
      body.state === "awake" || body.state === "waking" || body.state === "asleep" ? body.state : "unknown";
    const lastWakeMs =
      typeof body.lastWakeMs === "number" && Number.isFinite(body.lastWakeMs) && body.lastWakeMs >= 0
        ? Math.round(body.lastWakeMs)
        : null;
    return {
      sleep,
      lastWakeMs,
      sleptAt: asIsoTimestamp(body.sleptAt),
      wokeAt: asIsoTimestamp(body.wokeAt),
      sleepSeconds:
        typeof body.sleepSeconds === "number" && Number.isFinite(body.sleepSeconds) && body.sleepSeconds > 0
          ? body.sleepSeconds
          : null,
    };
  } catch {
    return UNKNOWN_GATE;
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
  const costPerHour = previewCostPerHour();
  const [state, deployments] = await Promise.all([
    exclusive(async () => loadState()),
    getDeployer().list(),
  ]);

  setCurrentPolicy(state.policy);
  const policy = currentPolicy();
  const sorted = state.environments.map(refreshPreviewUrl).sort((a, b) => {
    const liveRank = Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status));
    if (liveRank !== 0) return liveRank;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const environments: Environment[] = await Promise.all(
    sorted.map(async (env) => {
      const gate = await readGate(env, deployments);
      const keepAwakeUntil =
        env.keepAwakeUntil && Date.parse(env.keepAwakeUntil) > Date.now() ? env.keepAwakeUntil : null;
      return {
        ...env,
        sleep: gate.sleep,
        lastWakeMs: gate.lastWakeMs,
        sleepSeconds: sleepSecondsForRepo(env.repository),
        keepAwakeUntil,
        keptByLabel: isLiveStatus(env.status) && hasKeepLabel(env.labels),
      };
    }),
  );

  const usage = usageForMonth(state.usage, Date.now());
  const currency = previewCurrency();
  return {
    environments,
    deployments: deployments.map((item) => {
      const next = expectedPreviewUrl(item.repository, item.prNumber);
      return previewUrlIsCurrent(item.url, next) ? item : { ...item, url: next };
    }),
    config: {
      maxConcurrent: config.maxConcurrent,
      ttlHours: policy.ttlHours ?? config.ttlHours,
      idleHours: config.idleHours,
      sleepSeconds: policy.sleepSeconds ?? config.sleepSeconds,
      reaperIntervalMs: config.reaperIntervalMs,
      previewBaseUrl: config.previewBaseUrl,
      deployer: config.deployer,
      webhookVerification: config.webhookSecret ? "signed" : "open-in-development",
      demo: config.demo ? `${config.demo.repository}#${config.demo.prNumber}` : null,
      allowedRepositories: buildsPullRequests() ? previewRepos() : null,
      onRender: Boolean(process.env.RENDER),
      githubConnected: githubConfigured(),
      privatePreviews: previewsProtected(),
      currency,
      policy: {
        ttlHours: policy.ttlHours ?? config.ttlHours,
        sleepSeconds: policy.sleepSeconds ?? config.sleepSeconds,
        maxLifetimeHours: config.maxLifetimeHours,
        maxExtensions: policy.maxExtensions,
        maxPerAuthor: policy.maxPerAuthor,
        keepLabel: policy.keepLabel,
        warnMinutes: policy.warnMinutes,
      },
    },
    summary: {
      live: environments.filter((env) => isLiveStatus(env.status)).length,
      destroyed: environments.filter((env) => env.status === "destroyed").length,
      failed: environments.filter((env) => env.status === "failed").length,
      awake: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "awake").length,
      waking: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "waking").length,
      asleep: environments.filter((env) => isLiveStatus(env.status) && env.sleep === "asleep").length,
    },
    usage,
    costPerHour,
    savedEstimate: (moneySeconds(usage).asleep / 3600) * costPerHour,
    currency,
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
  buildMs: number | null,
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
    env.buildMs = buildMs;
    if (typeof buildMs === "number") {
      pushEnvironmentEvent(env, { at: now, type: "built", detail: secondsDetail(buildMs) });
    }
    pushEnvironmentEvent(env, { at: now, type: "ready" });
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
    pushEnvironmentEvent(env, { at: env.updatedAt, type: "failed", detail: firstLine(message) });
    env.comments.push({ at: env.updatedAt, body: failedComment(env, message) });
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
  await exclusive(async () => {
    const state = await loadState();
    const current = state.environments.find((item) => item.id === env.id);
    if (!current || current.updateGeneration !== generation) return;
    if (current.status === "destroying" || current.status === "destroyed") return;
    pushEnvironmentEvent(current, { at: iso(), type: "build_started" });
    await saveState(state);
  });
  await statusQuietly(env, {
    state: "pending",
    description: action === "updated" ? "Updating preview…" : "Building preview…",
  });

  const started = Date.now();
  let deployment: Deployment;
  try {
    deployment = await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deploy failed";
    const failed = await markDeployFailed(env.id, generation, message);
    if (failed) {
      await statusQuietly(failed, {
        state: "failure",
        description: "Mayfly — Preview failed",
      });
      const failBody = failed.comments.at(-1)?.body;
      if (failBody) await commentQuietly(failed, failBody);
      if (!isDemo(failed)) {
        void sendAlert(`build:${failed.id}:${failed.sha}`, `a preview failed to build`, [
          `${failed.repository} #${failed.prNumber} (${failed.branch}, ${failed.sha.slice(0, 8)})`,
          firstLine(message),
          `https://github.com/${failed.repository}/pull/${failed.prNumber}`,
        ]);
      }
    }
    return {
      ok: false,
      code: "deploy_failed",
      error: message,
      environment: failed ?? undefined,
    };
  }

  const buildMs = Math.max(0, Date.now() - started);
  const applied = await applyDeployment(
    env.id,
    generation,
    deployment,
    (current) => readyComment(current, true),
    buildMs,
  );
  if (applied.stale) {
    await getDeployer().destroy({ deploymentId: deployment.deploymentId }).catch((error) => {
      console.error("Failed to roll back a stale deployment", error);
    });
    if (!applied.environment) {
      return { ok: false, code: "not_found", error: "Environment disappeared during deploy." };
    }
    return { ok: true, action: "unchanged", environment: applied.environment };
  }

  if (applied.environment) {
    await statusQuietly(applied.environment, {
      state: "success",
      description: "Mayfly — Preview ready",
      targetUrl: applied.environment.url,
    });
    if (applied.commentBody) await commentQuietly(applied.environment, applied.commentBody);
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
          error: "This preview is busy building. Try again in a moment.",
          environment: clone(existing),
        };
      }

      existing.status = "updating";
      existing.sha = normalized.sha;
      existing.branch = normalized.branch;
      // Previews opened before authors were recorded pick it up from their next commit.
      if (!existing.author && normalized.author) existing.author = normalized.author;
      // Titles change; keep the newest one GitHub sent.
      if (normalized.title) existing.title = normalized.title;
      existing.updatedAt = now;
      existing.lastActiveAt = now;
      // Keep the later of the current expiry and a fresh TTL so an extended preview is not shortened.
      existing.expiresAt = iso(Math.max(Date.parse(existing.expiresAt), Date.parse(expiresAt)));
      existing.error = null;
      existing.updateGeneration += 1;
      pushEnvironmentEvent(existing, { at: now, type: "updated", detail: normalized.sha.slice(0, 8) });
      const labels = eventLabels(normalized);
      if (labels) {
        const wasKept = hasKeepLabel(existing.labels);
        existing.labels = labels;
        noteKeepChange(existing, wasKept, now);
      }
      await saveState(state);
      return { ok: true, action: "updated", environment: clone(existing) };
    }

    // Per-developer limit from TTL policies. Previews being removed don't count; the demo never does.
    const perAuthor = currentPolicy().maxPerAuthor;
    if (perAuthor !== null && normalized.author) {
      const login = normalized.author.toLowerCase();
      const mine = state.environments.filter(
        (env) =>
          env.status !== "destroying" &&
          isLiveStatus(env.status) &&
          !isDemo(env) &&
          env.author?.toLowerCase() === login,
      );
      if (mine.length >= perAuthor) {
        return {
          ok: false,
          code: "author_cap",
          error: `${normalized.author} already has ${mine.length} preview${mine.length === 1 ? "" : "s"} running, the most allowed per person (${perAuthor}).`,
        };
      }
    }

    const config = getConfig();
    const live = state.environments.filter((env) => isLiveStatus(env.status)).length;
    if (live >= config.maxConcurrent) {
      return {
        ok: false,
        code: "cap",
        error: `Mayfly is already running its maximum of ${config.maxConcurrent} previews. Close a pull request, or wait for an old preview to run out of time.`,
      };
    }

    // The plan: how many previews and repositories at a time, and which sizes. The built-in demo is exempt.
    const creatingDemo = isDemo({ repository: normalized.repository, prNumber: normalized.prNumber } as Environment);
    const allowed = creatingDemo
      ? null
      : checkNewPreview(
          currentPlan(state.plan),
          state.environments,
          {
            repository: normalized.repository,
            size: normalized.size ?? null,
            defaultSize: state.previewSettings?.[normalized.repository]?.size ?? null,
            standardHours: monthHours(state.usage).standardHours,
          },
          isDemo,
        );
    if (allowed && !allowed.ok) return { ok: false, code: "plan_cap", error: allowed.error };

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
      events: [{ at: now, type: "opened" }],
      labels: eventLabels(normalized) ?? [],
      extensions: 0,
      ...(normalized.author ? { author: normalized.author } : {}),
      ...(normalized.title ? { title: normalized.title } : {}),
      // A size chosen by hand wins; otherwise the repository's preview settings decide (Standard when unset, or
      // when the plan doesn't include the saved size).
      ...(() => {
        const size = allowed?.ok ? allowed.size : (normalized.size ?? state.previewSettings?.[normalized.repository]?.size);
        return size && size !== "standard" ? { size } : {};
      })(),
      ...(typeof normalized.budget === "number" && normalized.budget > 0 ? { budget: normalized.budget } : {}),
    };
    if (hasKeepLabel(created.labels)) {
      pushEnvironmentEvent(created, { at: now, type: "kept", detail: currentPolicy().keepLabel });
    }
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
    size: environment.size,
  };
  const work = action === "created" ? () => deployer.provision(request) : () => deployer.update(request);
  return runDeploy(environment, work, action);
}

/**
 * Tell the developer on the PR why no preview started. Uses the one edit-in-place Mayfly comment, so
 * repeated pushes don't add more comments.
 */
async function explainAuthorLimit(event: PullRequestEvent) {
  const limit = currentPolicy().maxPerAuthor ?? 0;
  const state = await exclusive(async () => loadState());
  const login = (event.author ?? "").toLowerCase();
  const others = state.environments.filter(
    (env) => isLiveStatus(env.status) && !isDemo(env) && env.author?.toLowerCase() === login,
  );
  // Name only pull requests in this repository: another repository may be private.
  const here = others.filter((env) => env.repository === event.repository).map((env) => `#${env.prNumber}`);
  const elsewhere = others.length - here.length;
  const where = [
    here.length ? `${here.join(", ")} in this repository` : "",
    elsewhere ? `${elsewhere} in other repositories` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const body = [
    "**Mayfly preview not started**",
    "",
    `The author of this pull request already has ${others.length} live preview${others.length === 1 ? "" : "s"} (${where}), the most allowed per developer (${limit}).`,
    "",
    "Close or merge one of those pull requests, then push a new commit here to start this preview.",
    "",
    lastUpdatedLine(),
  ].join("\n");
  try {
    await publishPullRequestComment(event.repository, event.prNumber, body, null);
  } catch (error) {
    console.error("Pull request comment failed", error);
  }
}

/** Tell the developer on the PR that the plan's limit stopped this preview, using the one Mayfly comment. */
async function explainPlanLimit(event: PullRequestEvent, reason: string) {
  const base = getConfig().previewBaseUrl;
  const body = [
    "**Mayfly preview not started**",
    "",
    reason,
    "",
    `Once there's room, push a new commit here to start this preview. Plans: ${base}/pricing`,
    "",
    lastUpdatedLine(),
  ].join("\n");
  try {
    await publishPullRequestComment(event.repository, event.prNumber, body, null);
  } catch (error) {
    console.error("Pull request comment failed", error);
  }
}

/** A label was added or removed on the pull request: no rebuild, only the keep label matters. */
async function applyLabels(event: PullRequestEvent): Promise<LifecycleResult> {
  const result = await saveLabels(event);
  if (result.ok && result.action === "labels") await refreshReadyComment(result.environment.id);
  return result;
}

async function saveLabels(event: PullRequestEvent): Promise<LifecycleResult> {
  const normalized = normalizeEvent(event);
  return exclusive(async () => {
    const state = await loadState();
    const env = findLive(state.environments, normalized.repository, normalized.prNumber);
    if (!env) {
      return { ok: false, code: "not_found", error: `There's no running preview for ${normalized.repository} #${normalized.prNumber}.` };
    }
    const labels = eventLabels(normalized) ?? [];
    const wasKept = hasKeepLabel(env.labels);
    env.labels = labels;
    noteKeepChange(env, wasKept, iso());
    await saveState(state);
    return { ok: true, action: wasKept === hasKeepLabel(labels) ? "unchanged" : "labels", environment: clone(env) };
  });
}

export async function applyPullRequestEvent(
  event: PullRequestEvent,
  options?: { wait?: boolean },
): Promise<LifecycleResult> {
  if (event.action === "labeled" || event.action === "unlabeled") {
    return applyLabels(event);
  }
  if (event.action === "closed") {
    const normalized = normalizeEvent(event);
    const existing = await exclusive(async () => {
      const state = await loadState();
      return findLive(state.environments, normalized.repository, normalized.prNumber) ?? null;
    });
    if (!existing) {
      return { ok: false, code: "not_found", error: `There's no running preview for ${normalized.repository} #${normalized.prNumber}.` };
    }
    return destroyEnvironment(existing.id, normalized.merged ? "merged" : "closed", options);
  }

  // The pull request's code is fetched from the base repository, so a fork's code would be built too. Refuse it.
  if (
    buildsPullRequests() &&
    event.headRepository !== undefined &&
    event.headRepository.trim().toLowerCase() !== event.repository.trim().toLowerCase()
  ) {
    return { ok: false, code: "invalid", error: "Pull requests from forks don't get previews, to keep the server safe." };
  }

  const reserved = await reserve(event);
  if (!reserved.ok) {
    if (reserved.code === "author_cap") void explainAuthorLimit(normalizeEvent(event));
    if (reserved.code === "plan_cap") void explainPlanLimit(normalizeEvent(event), reserved.error);
    return reserved;
  }
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
      // Leftover process/container may already be gone (common for failed previews).
      const missing = /not found|no such|ENOENT|does not exist|already removed/i.test(message);
      if (!missing) {
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
    pushEnvironmentEvent(env, {
      at: now,
      type: "destroyed",
      detail: env.destroyReason ?? undefined,
    });
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
    if (!env) return { ok: false as const, code: "not_found" as const, error: "That preview doesn't exist any more." };
    if (env.status === "destroyed") {
      return { ok: true as const, action: "unchanged" as const, environment: clone(env) };
    }
    // Failed previews can still be removed: clean up any leftover deploy for this id, then mark destroyed.
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

function monthKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 7);
}

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

const USAGE_DAY_RETENTION = 31;

/**
 * Add sampled time to a total: plain seconds for hours, and the same weighted by the preview's size for money.
 * A total from before sizes existed starts its weighted figure at its plain one (every preview was Standard).
 */
function addTime(total: UsageDay, kind: "awake" | "asleep", seconds: number, weighted: number) {
  if (kind === "awake") {
    total.awakeWeighted = (total.awakeWeighted ?? total.awakeSeconds) + weighted;
    total.awakeSeconds += seconds;
  } else {
    total.asleepWeighted = (total.asleepWeighted ?? total.asleepSeconds) + weighted;
    total.asleepSeconds += seconds;
  }
}

function pruneUsageDays(days: Record<string, UsageDay> | undefined, nowMs: number): Record<string, UsageDay> {
  const kept: Record<string, UsageDay> = {};
  const cutoff = dayKey(nowMs - (USAGE_DAY_RETENTION - 1) * 24 * 60 * 60 * 1000);
  for (const [key, value] of Object.entries(days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < cutoff) continue;
    if (!value || typeof value !== "object") continue;
    const awake = value.awakeSeconds;
    const asleep = value.asleepSeconds;
    if (typeof awake !== "number" || !Number.isFinite(awake) || awake < 0) continue;
    if (typeof asleep !== "number" || !Number.isFinite(asleep) || asleep < 0) continue;
    kept[key] = {
      awakeSeconds: awake,
      asleepSeconds: asleep,
      ...(typeof value.awakeWeighted === "number" ? { awakeWeighted: value.awakeWeighted } : {}),
      ...(typeof value.asleepWeighted === "number" ? { asleepWeighted: value.asleepWeighted } : {}),
    };
  }
  return kept;
}

function emptyUsage(ms: number, days?: UsageMonth["days"]): UsageMonth {
  return {
    month: monthKey(ms),
    asleepSeconds: 0,
    awakeSeconds: 0,
    lastSampleAt: iso(ms),
    days: pruneUsageDays(days, ms),
  };
}

function usageForMonth(usage: UsageMonth | undefined, ms: number): UsageMonth {
  if (!usage || usage.month !== monthKey(ms)) return emptyUsage(ms, usage?.days);
  return { ...usage, days: pruneUsageDays(usage.days, ms) };
}

/** First reaper tick after process start only reseeds lastSampleAt — downtime is not estimated. */
let usageSampleReady = false;

const EXTEND_HOURS = new Set([2, 4, 12, 24]);

/** Push expiresAt forward by a fixed number of hours, capped at createdAt + max lifetime. */
export async function extendEnvironment(id: string, hours: number): Promise<LifecycleResult> {
  const result = await extendExpiry(id, hours);
  if (result.ok) await refreshReadyComment(id);
  return result;
}

async function extendExpiry(id: string, hours: number): Promise<LifecycleResult> {
  if (!EXTEND_HOURS.has(hours)) {
    return { ok: false, code: "invalid", error: "hours must be 2, 4, 12, or 24." };
  }

  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false, code: "not_found", error: "That preview doesn't exist any more." };
    if (env.status === "destroying" || env.status === "destroyed" || !isLiveStatus(env.status)) {
      return {
        ok: false,
        code: "conflict",
        error: "Only a running preview can be extended.",
        environment: clone(env),
      };
    }
    if (isDemo(env)) {
      return {
        ok: false,
        code: "invalid",
        error: "The demo preview never runs out, so there's nothing to extend.",
        environment: clone(env),
      };
    }

    const limit = currentPolicy().maxExtensions;
    const used = env.extensions ?? 0;
    if (limit !== null && used >= limit) {
      const label = currentPolicy().keepLabel;
      return {
        ok: false,
        code: "invalid",
        error:
          limit === 0
            ? "Extending previews is turned off in Lifetime rules."
            : `This preview has used all ${limit} extension${limit === 1 ? "" : "s"}.` +
              (label ? ` Add the “${label}” label to the pull request to keep it.` : ""),
        environment: clone(env),
      };
    }

    const nowMs = Date.now();
    const currentExpires = Date.parse(env.expiresAt);
    const createdMs = Date.parse(env.createdAt);
    const cap = createdMs + getConfig().maxLifetimeMs;
    const base = Math.max(nowMs, currentExpires);
    if (!(base < cap)) {
      return {
        ok: false,
        code: "invalid",
        error: "This preview is already at the longest it's allowed to run.",
        environment: clone(env),
      };
    }

    const next = Math.min(base + hours * 60 * 60 * 1000, cap);
    env.expiresAt = iso(next);
    env.updatedAt = iso(nowMs);
    env.extensions = used + 1;
    env.warnedFor = null;
    pushEnvironmentEvent(env, { at: env.updatedAt, type: "extended", detail: env.expiresAt });
    await saveState(state);
    return { ok: true, action: "updated", environment: clone(env) };
  });
}

async function gatePortFor(env: Environment): Promise<number | null> {
  if (!env.deploymentId) return null;
  const deployments = await getDeployer().list();
  const port = deployments.find((item) => item.deploymentId === env.deploymentId)?.port;
  return port && Number.isInteger(port) ? port : null;
}

/** Tell the gate on this machine to suppress idle sleep until `until` (ISO), or clear with null. */
async function tellGateKeepAwake(env: Environment, until: string | null): Promise<boolean> {
  const port = await gatePortFor(env);
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_keepawake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until }),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Tell a running gate to use a new idle time, so a policy change applies without a rebuild. */
async function tellGateIdle(port: number, seconds: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_idle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds }),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Push each live preview's current idle time to its gate when the gate uses a different one. */
async function syncGateIdle(
  envs: Environment[],
  deployments: DeploymentRecord[],
  known?: Map<string, GateStatus>,
): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;
  for (const env of envs) {
    if (env.status !== "ready" && env.status !== "updating") continue;
    const port = deployments.find((item) => item.deploymentId === env.deploymentId)?.port;
    if (!port || !Number.isInteger(port)) continue;
    const want = sleepSecondsForRepo(env.repository);
    const have = known?.get(env.id)?.sleepSeconds;
    if (known && (have == null || have === want)) continue;
    if (await tellGateIdle(port, want)) updated += 1;
    else failed += 1;
  }
  return { updated, failed };
}

const KEEP_AWAKE_HOURS = new Set([1, 2, 4, 8]);

/** Hold a live preview awake for 1, 2, 4, or 8 hours (no idle sleep). */
export async function keepAwakeEnvironment(id: string, hours: number): Promise<LifecycleResult> {
  if (!KEEP_AWAKE_HOURS.has(hours)) {
    return { ok: false, code: "invalid", error: "hours must be 1, 2, 4, or 8." };
  }

  const reserved = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false as const, code: "not_found" as const, error: "That preview doesn't exist any more." };
    if (env.status !== "ready" && env.status !== "updating") {
      return {
        ok: false as const,
        code: "conflict" as const,
        error: "Only a running preview can be kept awake.",
        environment: clone(env),
      };
    }
    const until = iso(Date.now() + hours * 60 * 60 * 1000);
    env.keepAwakeUntil = until;
    env.updatedAt = iso();
    pushEnvironmentEvent(env, { at: env.updatedAt, type: "keep_awake", detail: until });
    await saveState(state);
    return { ok: true as const, environment: clone(env) };
  });
  if (!reserved.ok) return reserved;

  const told = await tellGateKeepAwake(reserved.environment, reserved.environment.keepAwakeUntil ?? null);
  if (!told) {
    return {
      ok: false,
      code: "deploy_failed",
      error: "The preview didn't answer. Try again in a moment.",
      environment: reserved.environment,
    };
  }
  return { ok: true, action: "keep_awake", environment: reserved.environment };
}

/** Clear keep-awake so normal idle sleep resumes. */
export async function keepAwakeOffEnvironment(id: string): Promise<LifecycleResult> {
  const reserved = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false as const, code: "not_found" as const, error: "That preview doesn't exist any more." };
    if (env.status !== "ready" && env.status !== "updating" && env.status !== "failed") {
      return {
        ok: false as const,
        code: "conflict" as const,
        error: "Only a running preview can be allowed to sleep again.",
        environment: clone(env),
      };
    }
    env.keepAwakeUntil = null;
    env.updatedAt = iso();
    pushEnvironmentEvent(env, { at: env.updatedAt, type: "keep_awake_off" });
    await saveState(state);
    return { ok: true as const, environment: clone(env) };
  });
  if (!reserved.ok) return reserved;

  await tellGateKeepAwake(reserved.environment, null);
  return { ok: true, action: "keep_awake_off", environment: reserved.environment };
}

/** Ask the gate on this machine to stop the app. The public /p/ proxy is not used. */
export async function sleepEnvironment(id: string): Promise<LifecycleResult> {
  const located = await exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false as const, code: "not_found" as const, error: "That preview doesn't exist any more." };
    if (env.status !== "ready" && env.status !== "updating") {
      return {
        ok: false as const,
        code: "conflict" as const,
        error: "Only a running preview can be put to sleep.",
        environment: clone(env),
      };
    }
    return { ok: true as const, environment: clone(env) };
  });
  if (!located.ok) return located;

  const port = await gatePortFor(located.environment);
  if (!port) {
    return {
      ok: false,
      code: "conflict",
      error: "This preview isn't running, so there's nothing to put to sleep.",
      environment: located.environment,
    };
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/__preview_sleep`, { method: "POST", cache: "no-store" });
    if (!response.ok) {
      return { ok: false, code: "deploy_failed", error: "The preview didn't answer. Try again in a moment.", environment: located.environment };
    }
  } catch {
    return { ok: false, code: "deploy_failed", error: "The preview didn't answer. Try again in a moment.", environment: located.environment };
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

/** How often a visit is written into a preview's history. */
export const VISIT_EVENT_GAP_MS = 30 * 60 * 1000;

export async function recordActivity(id: string): Promise<LifecycleResult> {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === id);
    if (!env) return { ok: false, code: "not_found", error: "That preview doesn't exist any more." };
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
    // Note a visit in the history at most once every 30 minutes (a wake counts as one), so a busy preview's
    // visits don't push its older history out of the 50 kept events.
    const lastVisit = Math.max(lastEventAt(env, "visited"), lastEventAt(env, "woke"));
    if (Date.parse(now) - lastVisit >= VISIT_EVENT_GAP_MS) pushEnvironmentEvent(env, { at: now, type: "visited" });
    await saveState(state);
    return { ok: true, action: "activity", environment: clone(env) };
  });
}

function docker(args: string[]) {
  return new Promise<string>((resolve) => {
    execFile("docker", args, { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? ""));
    });
  });
}

/** Drop preview containers whose environment is gone. Live ones are started again by restorePreviews. */
export async function removeOrphanPreviewContainers() {
  if (previewRuntime() !== "docker") return;
  const state = await loadState();
  const liveEnvs = state.environments.filter((env) => isLiveStatus(env.status));
  const live = new Set(liveEnvs.map((env) => env.id));
  // Image tags are shared by PR+commit; keep any tag still needed by a live environment.
  const liveImageTags = new Set(liveEnvs.map((env) => imageTag(env.repository, env.prNumber, env.sha)));

  const listed = await docker(["ps", "-aq", "--filter", "label=mayfly.preview=1"]);
  const ids = listed.split(/\s+/).filter(Boolean);
  const orphans: string[] = [];
  for (const id of ids) {
    const envId = (await docker(["inspect", "--format", '{{index .Config.Labels "mayfly.env"}}', id])).trim();
    if (!live.has(envId)) orphans.push(id);
  }
  if (orphans.length > 0) await docker(["rm", "-f", ...orphans]);

  // Images built for pull requests that are gone.
  const images = (await docker(["images", "-q", "--filter", "label=mayfly.image=1"])).split(/\s+/).filter(Boolean);
  const staleImages: string[] = [];
  for (const id of new Set(images)) {
    const tagsRaw = (
      await docker(["image", "inspect", "--format", "{{range .RepoTags}}{{.}} {{end}}", id])
    ).trim();
    const tags = tagsRaw.split(/\s+/).filter(Boolean);
    const needed = tags.some((tag) => liveImageTags.has(tag));
    if (!needed) staleImages.push(id);
  }
  if (staleImages.length > 0) await docker(["rmi", "-f", ...staleImages]);
}

/** After a restart the gate processes are gone. Start live previews again and leave ones that are still up. */
export async function restorePreviews() {
  const state = await loadState();
  const deployer = getDeployer();
  const live = state.environments.filter(
    (env) =>
      (env.status === "ready" || env.status === "updating" || env.status === "provisioning") && env.deploymentId,
  );
  for (const env of live) {
    try {
      await deployer.revive({
        envId: env.id,
        repository: env.repository,
        prNumber: env.prNumber,
        sha: env.sha,
        branch: env.branch,
        deploymentId: env.deploymentId,
        size: env.size,
      });
      const until = env.keepAwakeUntil;
      if (until && Date.parse(until) > Date.now()) {
        const told = await tellGateKeepAwake(env, until);
        if (!told) console.error(`Keep-awake was not restored for ${env.repository}#${env.prNumber}`);
      }
    } catch (error) {
      console.error(`Preview ${env.repository}#${env.prNumber} was not restored`, error);
    }
  }
}

/** The most recent event on this preview, by time. */
function newestEvent(env: Environment): EnvironmentEvent | null {
  let newest: EnvironmentEvent | null = null;
  for (const event of env.events ?? []) {
    if (!newest || Date.parse(event.at) >= Date.parse(newest.at)) newest = event;
  }
  return newest;
}

function formatUtc(isoTime: string) {
  return `${new Date(isoTime).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function formatLeft(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** Post a separate PR comment (so people are notified) before the preview's lifetime ends. */
async function postExpiryWarning(env: Environment) {
  const label = currentPolicy().keepLabel;
  const ways = [
    label ? `add the \`${label}\` label to this pull request` : null,
    "push a new commit",
    `extend it on [Mayfly Admin](${getConfig().previewBaseUrl}/admin)`,
  ].filter(Boolean);
  const body = [
    `**Mayfly preview expires in about ${formatLeft(Date.parse(env.expiresAt) - Date.now())}**`,
    "",
    `This pull request's preview will be removed at ${formatUtc(env.expiresAt)}.`,
    "",
    `To keep it longer: ${ways.slice(0, -1).join(", ")}, or ${ways.at(-1)}.`,
  ].join("\n");
  let posted = false;
  try {
    posted = await postPullRequestNote(env.repository, env.prNumber, body);
  } catch (error) {
    console.error("Expiry warning was not posted", error);
  }
  if (!posted) return;
  await exclusive(async () => {
    const state = await loadState();
    const current = state.environments.find((item) => item.id === env.id);
    if (!current) return;
    pushEnvironmentEvent(current, { at: iso(), type: "warned", detail: env.expiresAt });
    await saveState(state);
  });
}

export type FeedbackResult =
  | { ok: true; environment: Environment; item: FeedbackItem }
  | { ok: false; code: "not_found" | "conflict"; error: string };

/** The live preview for a pull request, with its feedback. Null when there is none. */
export async function getLivePreview(repository: string, prNumber: number): Promise<Environment | null> {
  const state = await loadState();
  const env = findLive(state.environments, repository.trim().toLowerCase(), prNumber);
  return env ? clone(env) : null;
}

/** Save a reviewer's comment on a live preview, note it in the history, then post it on the pull request. */
export async function addFeedback(envId: string, input: FeedbackInput): Promise<FeedbackResult> {
  const result = await exclusive(async (): Promise<FeedbackResult> => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    if (!env || !isLiveStatus(env.status) || env.status === "destroying") {
      return { ok: false, code: "not_found", error: "This preview has been removed, so it can't take comments." };
    }
    const list = env.feedback ?? [];
    if (list.length >= MAX_FEEDBACK_PER_PREVIEW) {
      return {
        ok: false,
        code: "conflict",
        error: `This preview already has ${MAX_FEEDBACK_PER_PREVIEW} comments. Ask an admin to clear some first.`,
      };
    }
    const at = iso();
    const item: FeedbackItem = { id: feedbackId(randomUUID), at, sha: env.sha, ...input };
    env.feedback = [...list, item];
    env.updatedAt = at;
    pushEnvironmentEvent(env, { at, type: "feedback", detail: input.author });
    await saveState(state);
    return { ok: true, environment: clone(env), item };
  });
  if (result.ok) {
    const { environment, item } = result;
    try {
      await postPullRequestNote(
        environment.repository,
        environment.prNumber,
        feedbackNote(item, feedbackLink(getConfig().previewBaseUrl, environment)),
      );
    } catch (error) {
      console.error("Feedback was not posted on the pull request", error);
    }
  }
  return result;
}

/** An admin removes a comment (spam, or done with). The note on GitHub stays. */
export async function deleteFeedback(envId: string, itemId: string): Promise<boolean> {
  return exclusive(async () => {
    const state = await loadState();
    const env = state.environments.find((item) => item.id === envId);
    const list = env?.feedback ?? [];
    if (!env || !list.some((item) => item.id === itemId)) return false;
    env.feedback = list.filter((item) => item.id !== itemId);
    await saveState(state);
    return true;
  });
}

/** Load the saved policy into memory. Called at startup before previews are restored. */
export async function loadPolicy() {
  const state = await exclusive(async () => loadState());
  setCurrentPolicy(state.policy);
}

export interface PolicyView {
  policy: PreviewPolicy;
  /** What applies when a field is left empty: the environment variables. */
  defaults: {
    ttlHours: number;
    sleepSeconds: number;
    maxLifetimeHours: number;
    sleepRules: Record<string, number>;
  };
  /** Repositories worth offering in the rule picker. */
  repositories: string[];
  githubConnected: boolean;
}

export async function getPolicyView(): Promise<PolicyView> {
  const config = getConfig();
  const state = await exclusive(async () => loadState());
  setCurrentPolicy(state.policy);
  const policy = currentPolicy();
  const repositories = new Set<string>([
    ...previewRepos(),
    ...state.environments.filter((env) => isLiveStatus(env.status)).map((env) => env.repository),
    ...policy.repoRules.map((rule) => rule.repository),
  ]);
  const demo = config.demo?.repository;
  if (demo) repositories.delete(demo);
  return {
    policy,
    defaults: {
      ttlHours: config.ttlHours,
      sleepSeconds: config.sleepSeconds,
      maxLifetimeHours: config.maxLifetimeHours,
      sleepRules: Object.fromEntries(parseSleepRules()),
    },
    repositories: [...repositories].sort(),
    githubConnected: githubConfigured(),
  };
}

export type PolicySaveResult =
  | { ok: true; view: PolicyView; gates: { updated: number; failed: number } }
  | { ok: false; error: string };

/**
 * Save the policy from the TTL policies page. New lifetimes apply when a preview opens or gets a new commit;
 * sleep times apply to running previews right away.
 */
export async function savePolicy(input: unknown): Promise<PolicySaveResult> {
  const parsed = parsePolicy(input, iso());
  if (!parsed.ok) return parsed;

  const live = await exclusive(async () => {
    const state = await loadState();
    const keptBefore = new Map(state.environments.map((env) => [env.id, hasKeepLabel(env.labels)]));
    state.policy = parsed.policy;
    setCurrentPolicy(parsed.policy);
    // A renamed or removed keep label releases previews it was holding: give them a fresh lifetime.
    const now = iso();
    for (const env of state.environments) {
      if (!isLiveStatus(env.status)) continue;
      noteKeepChange(env, keptBefore.get(env.id) ?? false, now);
    }
    await saveState(state);
    return state.environments.filter((env) => isLiveStatus(env.status)).map((env) => clone(env));
  });

  const deployments = await getDeployer().list();
  const known = new Map<string, GateStatus>();
  await Promise.all(live.map(async (env) => known.set(env.id, await readGate(env, deployments))));
  const gates = await syncGateIdle(live, deployments, known);
  return { ok: true, view: await getPolicyView(), gates };
}

export async function reap(): Promise<ReapResult> {
  const config = getConfig();
  const now = Date.now();
  const deployments = await getDeployer().list();

  const sampled = await exclusive(async () => {
    const state = await loadState();
    return state.environments.filter((env) => isLiveStatus(env.status)).map((env) => clone(env));
  });
  const gateById = new Map<string, GateStatus>();
  await Promise.all(
    sampled.map(async (env) => {
      gateById.set(env.id, await readGate(env, deployments));
    }),
  );

  const warnings: Environment[] = [];
  const due = await exclusive(async () => {
    const state = await loadState();
    setCurrentPolicy(state.policy);
    const month = monthKey(now);
    let usage: UsageMonth;
    if (state.usage && state.usage.month === month) {
      usage = { ...state.usage, days: { ...(state.usage.days ?? {}) } };
    } else {
      usage = emptyUsage(now, state.usage?.days);
      // Keep the previous sample clock so a month boundary does not drop the open interval.
      if (state.usage?.lastSampleAt) usage.lastSampleAt = state.usage.lastSampleAt;
    }
    usage.days = pruneUsageDays(usage.days, now);
    if (!usageSampleReady) {
      usage.lastSampleAt = iso(now);
      usageSampleReady = true;
    } else if (state.usage) {
      // Same month or a rollover: sample from the previous lastSampleAt so a month boundary does not drop time.
      const elapsed = Math.min(
        300,
        Math.max(0, Math.floor((now - Date.parse(usage.lastSampleAt)) / 1000)),
      );
      if (elapsed > 0) {
        const today = dayKey(now);
        const day = usage.days?.[today] ?? { awakeSeconds: 0, asleepSeconds: 0 };
        for (const env of state.environments) {
          if (!isLiveStatus(env.status) || isDemo(env)) continue;
          const sleep = gateById.get(env.id)?.sleep;
          if (sleep !== "asleep" && sleep !== "awake") continue;
          const preview = env.usage ?? { awakeSeconds: 0, asleepSeconds: 0 };
          const weighted = elapsed * sizeWeight(env.size);
          if (sleep === "asleep") {
            preview.asleepSeconds += elapsed;
            addTime(usage, "asleep", elapsed, weighted);
            addTime(day, "asleep", elapsed, weighted);
          } else {
            preview.awakeSeconds += elapsed;
            addTime(usage, "awake", elapsed, weighted);
            addTime(day, "awake", elapsed, weighted);
          }
          env.usage = preview;
        }
        usage.days = { ...usage.days, [today]: day };
      }
      usage.lastSampleAt = iso(now);
    }
    state.usage = usage;

    // Record slept/woke from the gate's own timestamps (not the sample time). Both can land in one tick.
    for (const env of state.environments) {
      if (!isLiveStatus(env.status)) continue;
      const gate = gateById.get(env.id);
      if (!gate) continue;
      const pending: EnvironmentEvent[] = [];
      // The visit that woke a sleeping preview is recorded as the wake itself, so drop a "visited" noted
      // around the same moment (it can land just before the gate's wake time and would hide the wake).
      if (gate.wokeAt) {
        const wokeMs = Date.parse(gate.wokeAt);
        if (Number.isFinite(wokeMs) && wokeMs > lastEventAt(env, "woke") && env.events?.length) {
          env.events = withoutVisitNearWake(env.events, wokeMs);
        }
      }
      if (gate.sleptAt) {
        const sleptMs = Date.parse(gate.sleptAt);
        if (Number.isFinite(sleptMs) && sleptMs > lastEventAt(env, "slept")) {
          pending.push({ at: gate.sleptAt, type: "slept" });
        }
      }
      if (gate.wokeAt) {
        const wokeMs = Date.parse(gate.wokeAt);
        if (Number.isFinite(wokeMs) && wokeMs > lastEventAt(env, "woke")) {
          pending.push({
            at: gate.wokeAt,
            type: "woke",
            detail:
              gate.lastWakeMs == null ? undefined : secondsDetail(gate.lastWakeMs),
          });
        }
      }
      pending.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      // A sleep right after another sleep, with nothing in between (no visit, wake or build), is a Mayfly
      // restart: the gate starts the app again and it idles straight back to sleep. Don't record it.
      // Also never record a sleep/wake older than the newest event, so a skipped restart sleep isn't
      // picked up again on a later tick, after a wake.
      const newest = newestEvent(env);
      let lastType = newest?.type ?? null;
      let lastMs = newest ? Date.parse(newest.at) : 0;
      for (const event of pending) {
        const at = Date.parse(event.at);
        if (at <= lastMs) continue;
        if (event.type === "slept" && lastType === "slept") continue;
        pushEnvironmentEvent(env, event);
        lastType = event.type;
        lastMs = at;
      }
    }

    // Keep the saved state small: forget long-removed previews and old comment versions.
    const pruned = pruneEnvironments(state.environments, now);
    if (pruned.removedRecords || pruned.trimmedComments) {
      state.environments = pruned.environments;
      console.log(
        `Tidied saved state: ${pruned.removedRecords} old removed preview(s), ${pruned.trimmedComments} old comment version(s).`,
      );
    }

    await saveState(state);

    const targets: { id: string; reason: DestroyReason }[] = [];
    for (const env of state.environments) {
      const age = now - Date.parse(env.updatedAt);
      if (env.status === "provisioning" || env.status === "updating" || env.status === "destroying") {
        // A build has its own time limit. Waiting for a build slot is not being stuck.
        if (age > config.stuckMs && !isBuilding(env.id)) targets.push({ id: env.id, reason: "stuck" });
        continue;
      }
      if (env.status === "failed") {
        if (!isDemo(env) && age > config.stuckMs) targets.push({ id: env.id, reason: "failed" });
        continue;
      }
      if (env.status !== "ready") continue;
      // Idle previews are not destroyed here. The gate sleeps an unused app (the app process exits, the gate
      // stays up) and the next visit wakes it. Only the time limit ends a ready preview.
      if (isDemo(env)) continue;
      // The keep label holds a preview until its pull request closes.
      if (hasKeepLabel(env.labels)) continue;
      const expiresMs = Date.parse(env.expiresAt);
      if (now >= expiresMs) {
        targets.push({ id: env.id, reason: "expired" });
        continue;
      }
      // A budget set when the preview was started: remove it once its awake time has cost that much.
      if (typeof env.budget === "number" && env.budget > 0 && env.usage) {
        const spent = (env.usage.awakeSeconds / 3600) * hourlyRate(env, previewCostPerHour());
        if (spent >= env.budget) {
          targets.push({ id: env.id, reason: "budget" });
          continue;
        }
      }
      // Warn once per expiry time, and only when the preview lived longer than the warning window.
      const warnMs = currentPolicy().warnMinutes * 60_000;
      if (
        warnMs > 0 &&
        expiresMs - now <= warnMs &&
        expiresMs - Date.parse(env.createdAt) > warnMs &&
        env.warnedFor !== env.expiresAt
      ) {
        env.warnedFor = env.expiresAt;
        warnings.push(clone(env));
      }
    }
    if (warnings.length > 0) await saveState(state);
    return targets;
  });

  for (const env of warnings) await postExpiryWarning(env);
  await syncGateIdle(sampled, deployments, gateById);

  const destroyed: Environment[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const target of due) {
    const result = await destroyEnvironment(target.id, target.reason, { wait: true });
    if (result.ok && result.environment.status === "destroyed") destroyed.push(result.environment);
    else if (!result.ok) failed.push({ id: target.id, error: result.error });
    if (target.reason === "stuck" && result.ok) {
      const env = result.environment;
      void sendAlert(`stuck:${env.id}:${env.sha}`, "a preview got stuck and was removed", [
        `${env.repository} #${env.prNumber} (${env.branch}) didn't finish within ${Math.round(getConfig().stuckMs / 60_000)} minutes.`,
        "Push a new commit to try again. If it keeps happening, check the server log.",
      ]);
    }
  }
  await ensureDemo();
  return { ok: true, destroyed, failed };
}
