/**
 * What runs once a preview is ready, with stand-ins for state, GitHub and the gate: the smoke test and its GitHub
 * status, the comparison with production, results kept on the preview only for the commit they ran on, and rows in
 * the PR comment. Run with: npx tsx scripts/test-post-deploy.ts
 */
import assert from "node:assert/strict";
import { checkRows, isChecking, runPostDeploy, SMOKE_CONTEXT, VISUAL_CONTEXT, type PostDeployDeps } from "../src/lib/post-deploy";
import type { RepoSettings } from "../src/lib/preview-settings-shape";
import type { CheckRun } from "../src/lib/smoke";
import type { Environment } from "../src/lib/types";
import type { VisualResult } from "../src/lib/visual-diff";

const SHA = "a".repeat(40);
const at = "2026-11-26T12:00:00.000Z";

function harness(settings: RepoSettings | undefined, overrides: Partial<PostDeployDeps> = {}) {
  const env = { id: "e1", repository: "acme/web", prNumber: 4, sha: SHA, status: "ready", deploymentId: "dep_e1", url: "https://m.test/p/acme/web/4", events: [] } as unknown as Environment;
  const statuses: { state: string; description: string; context: string }[] = [];
  const refreshed: string[] = [];
  const ran: string[] = [];
  const deps: PostDeployDeps = {
    load: async () => env,
    save: async (_id, sha, change) => {
      if (env.sha !== sha) return null;
      change(env);
      return env;
    },
    settings: async () => settings,
    localUrl: async () => "http://127.0.0.1:5555",
    status: async (_env, input) => void statuses.push(input),
    refreshComment: async (id) => void refreshed.push(id),
    dataDir: "/data",
    smoke: async (base, checks, sha) => {
      ran.push(`smoke ${base} ${checks.map((c) => c.path).join(",")}`);
      return { at, sha, ok: true, summary: "GET / answered 200", results: [] } satisfies CheckRun;
    },
    compare: async (input) => {
      ran.push(`compare ${input.previewUrl} ${input.productionUrl}`);
      return { at, sha: input.sha, productionUrl: input.productionUrl, width: 1280, height: 800, mismatchPercent: 3.2, summary: "3.2% of the page differs from production" } satisfies VisualResult;
    },
    ...overrides,
  };
  return { env, deps, statuses, refreshed, ran };
}

async function main() {
  // The default: a home page check, a pending status first and a success after. No production address: no comparison.
  const plain = harness(undefined);
  await runPostDeploy("e1", plain.deps);
  assert.deepEqual(plain.ran, ["smoke http://127.0.0.1:5555 /"]);
  assert.deepEqual(plain.statuses.map((s) => `${s.context}:${s.state}`), [`${SMOKE_CONTEXT}:pending`, `${SMOKE_CONTEXT}:success`]);
  assert.equal(plain.statuses[1].description, "GET / answered 200");
  assert.equal(plain.env.checks?.ok, true);
  assert.equal(plain.env.visual, undefined);
  assert.deepEqual(plain.refreshed, ["e1"], "the PR comment is rewritten with the results");
  assert.match(plain.env.events?.at(-1)?.detail ?? "", /^passed: GET \/ answered 200/);
  assert.equal(isChecking("e1"), false);

  // The repository's own checks and a production address.
  const both = harness({ productionUrl: "https://shop.example.com/", smoke: [{ path: "/health", expectStatus: 200 }, { path: "/login", expectStatus: 200 }], vars: [], updatedAt: at });
  await runPostDeploy("e1", both.deps);
  assert.deepEqual(both.ran, ["smoke http://127.0.0.1:5555 /health,/login", "compare http://127.0.0.1:5555 https://shop.example.com/"]);
  assert.deepEqual(both.statuses.map((s) => `${s.context}:${s.state}`), [`${SMOKE_CONTEXT}:pending`, `${SMOKE_CONTEXT}:success`, `${VISUAL_CONTEXT}:success`]);
  assert.equal(both.env.visual?.mismatchPercent, 3.2);

  // A failing smoke test is a failure status and never throws; differences never go red.
  const failing = harness(
    { productionUrl: "https://shop.example.com/", vars: [], updatedAt: at },
    { smoke: async (_b, _c, sha) => ({ at, sha, ok: false, summary: "GET /: answered 500, expected 200", results: [] }) },
  );
  await runPostDeploy("e1", failing.deps);
  assert.equal(failing.statuses.find((s) => s.state === "failure")?.context, SMOKE_CONTEXT);
  assert.equal(failing.statuses.find((s) => s.context === VISUAL_CONTEXT)?.state, "success");
  assert.equal(failing.env.checks?.ok, false);

  // A comparison that couldn't be made is kept on the preview, with no GitHub status.
  const noBrowser = harness(
    { productionUrl: "https://shop.example.com/", vars: [], updatedAt: at },
    { compare: async (input) => ({ at, sha: input.sha, productionUrl: input.productionUrl, width: 0, height: 0, mismatchPercent: null, summary: "No browser", problem: "No browser" }) },
  );
  await runPostDeploy("e1", noBrowser.deps);
  assert.equal(noBrowser.env.visual?.problem, "No browser");
  assert.ok(!noBrowser.statuses.some((s) => s.context === VISUAL_CONTEXT));

  // Only the one you ask for runs.
  const onlyVisual = harness({ productionUrl: "https://shop.example.com/", vars: [], updatedAt: at });
  await runPostDeploy("e1", onlyVisual.deps, "visual");
  assert.equal(onlyVisual.ran.length, 1);
  assert.match(onlyVisual.ran[0], /^compare/);

  // A new commit while the checks ran: the old results aren't saved against the new commit.
  const racing = harness(undefined, {
    smoke: async (_b, _c, sha) => {
      racing.env.sha = "b".repeat(40);
      return { at, sha, ok: true, summary: "GET / answered 200", results: [] };
    },
  });
  await runPostDeploy("e1", racing.deps);
  assert.equal(racing.env.checks, undefined);
  assert.deepEqual(racing.refreshed, []);

  // Not running, or no way to reach it: nothing happens.
  const asleepForever = harness(undefined, { localUrl: async () => null });
  await runPostDeploy("e1", asleepForever.deps);
  assert.deepEqual(asleepForever.statuses, []);
  const building = harness(undefined);
  building.env.status = "updating";
  await runPostDeploy("e1", building.deps);
  assert.deepEqual(building.ran, []);

  // A failure inside a step doesn't escape, and the next run still works.
  const broken = harness(undefined, { smoke: async () => { throw new Error("kaboom"); } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await runPostDeploy("e1", broken.deps);
  } finally {
    console.error = originalError;
  }
  assert.equal(isChecking("e1"), false);

  // Two runs for the same preview at once: the second is skipped.
  let release: () => void = () => {};
  const slow = harness(undefined, { smoke: (_b, _c, sha) => new Promise((resolve) => (release = () => resolve({ at, sha, ok: true, summary: "ok", results: [] }))) });
  const first = runPostDeploy("e1", slow.deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isChecking("e1"), true);
  await runPostDeploy("e1", slow.deps);
  release();
  await first;
  assert.equal(slow.statuses.filter((s) => s.state === "pending").length, 1);

  // Rows for the PR comment: this commit's results only, nothing for an uncompared page, pipes can't break the table.
  const env = { sha: SHA, checks: { at, sha: SHA, ok: false, summary: "GET /a|b: answered 500", results: [] } as CheckRun, visual: { at, sha: SHA, productionUrl: "https://shop.example.com/", width: 1, height: 1, mismatchPercent: 3.2, summary: "3.2% of the page differs from production" } as VisualResult };
  const rows = checkRows(env, "https://m.test/admin");
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| \*\*Smoke test\*\* \| Failed: GET \/a\\\|b: answered 500 \|$/);
  assert.match(rows[1], /3\.2% of the page differs from production \(\[see the screenshots\]\(https:\/\/m\.test\/admin\)\)/);
  assert.deepEqual(checkRows({ ...env, sha: "c".repeat(40) }, null), [], "results from an earlier commit aren't shown");
  assert.equal(checkRows({ ...env, visual: { ...env.visual, problem: "No browser" } }, null).length, 1);

  console.log("post-deploy: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
