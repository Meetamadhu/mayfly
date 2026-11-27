import type { RepoSettings } from "./preview-settings-shape";
import { checksFor, runChecks, type CheckRun } from "./smoke";
import { compareToProduction, type VisualResult } from "./visual-diff";
import type { Environment } from "./types";

/**
 * What happens once a preview is ready: its smoke checks run and go to GitHub as a commit status, and, if the
 * repository has a production address, the preview is screenshotted next to it. Nothing here can fail a deploy or
 * take a preview down. Lifecycle supplies the pieces that touch state, GitHub and the gate.
 */

export const SMOKE_CONTEXT = "Mayfly — Smoke test";
export const VISUAL_CONTEXT = "Mayfly — Visual diff";

export interface PostDeployDeps {
  load(id: string): Promise<Environment | null>;
  /** Change the saved preview, only if it's still on this commit. Returns the saved preview. */
  save(id: string, sha: string, change: (env: Environment) => void): Promise<Environment | null>;
  settings(repository: string): Promise<RepoSettings | undefined>;
  /** Where Mayfly itself reaches the preview (the gate on this machine), or null when it isn't running. */
  localUrl(env: Environment): Promise<string | null>;
  status(env: Environment, input: { state: "pending" | "success" | "failure" | "error"; description: string; context: string }): Promise<void>;
  /** The PR comment is rewritten once there are results to show. */
  refreshComment(id: string): Promise<void>;
  dataDir: string;
  /** For tests. */
  smoke?: typeof runChecks;
  compare?: typeof compareToProduction;
}

export type Which = "smoke" | "visual" | "both";

// One at a time: a headless browser is heavy, and checks of several previews at once would slow each other.
let queue: Promise<unknown> = Promise.resolve();
const running = new Set<string>();

function limit(text: string, max = 140) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Run the checks and the comparison for one preview. Never throws. Skips a preview already being checked. */
export function runPostDeploy(envId: string, deps: PostDeployDeps, which: Which = "both"): Promise<void> {
  if (running.has(envId)) return Promise.resolve();
  running.add(envId);
  const job = queue.then(() => work(envId, deps, which)).catch((error) => {
    console.error("Preview checks failed to run", error instanceof Error ? error.message : error);
  });
  queue = job;
  return job.finally(() => running.delete(envId));
}

export function isChecking(envId: string) {
  return running.has(envId);
}

async function work(envId: string, deps: PostDeployDeps, which: Which) {
  const env = await deps.load(envId);
  if (!env || env.status !== "ready" || !env.deploymentId) return;
  const settings = await deps.settings(env.repository);
  const base = await deps.localUrl(env);
  if (!base) return;
  const sha = env.sha;
  let changed = false;

  if (which !== "visual") {
    await deps.status(env, { state: "pending", description: "Checking the preview…", context: SMOKE_CONTEXT });
    const run: CheckRun = await (deps.smoke ?? runChecks)(base, checksFor(settings?.smoke), sha);
    const saved = await deps.save(envId, sha, (current) => {
      current.checks = run;
      current.events = [...(current.events ?? []), { at: run.at, type: "checks", detail: `${run.ok ? "passed" : "failed"}: ${run.summary}` }].slice(-50);
    });
    if (saved) {
      changed = true;
      await deps.status(saved, { state: run.ok ? "success" : "failure", description: limit(run.summary), context: SMOKE_CONTEXT });
    }
  }

  if (which !== "smoke" && settings?.productionUrl) {
    const result: VisualResult = await (deps.compare ?? compareToProduction)({
      dataDir: deps.dataDir,
      envId,
      sha,
      previewUrl: base,
      productionUrl: settings.productionUrl,
    });
    const saved = await deps.save(envId, sha, (current) => {
      current.visual = result;
    });
    if (saved) {
      changed = true;
      // Differences are expected in a pull request, so this status never goes red. A comparison that couldn't be
      // made is only on the preview's panel.
      if (!result.problem) await deps.status(saved, { state: "success", description: limit(result.summary), context: VISUAL_CONTEXT });
    }
  }

  if (changed) await deps.refreshComment(envId);
}

/** Rows for the PR comment, Markdown table cells. `link` is where an admin sees the screenshots. */
export function checkRows(env: Pick<Environment, "checks" | "visual" | "sha">, link: string | null): string[] {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const rows: string[] = [];
  const checks = env.checks;
  if (checks && checks.sha === env.sha) {
    rows.push(`| **Smoke test** | ${checks.ok ? "Passed" : "Failed"}: ${cell(checks.summary)} |`);
  }
  const visual = env.visual;
  if (visual && visual.sha === env.sha && !visual.problem) {
    rows.push(`| **Compared with production** | ${cell(visual.summary)}${link ? ` ([see the screenshots](${link}))` : ""} |`);
  }
  return rows;
}
