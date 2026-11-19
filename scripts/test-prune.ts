/**
 * Checks for the saved-state limits. Run: npx tsx scripts/test-prune.ts
 */
import { KEEP_COMMENT_VERSIONS, pruneEnvironments } from "../src/lib/prune";
import type { Environment } from "../src/lib/types";

const now = Date.parse("2026-11-19T12:00:00Z");
const DAY = 86_400_000;
let n = 0;
function check(cond: boolean, msg: string, detail?: unknown) {
  if (!cond) throw new Error(`FAIL ${msg} ${JSON.stringify(detail)}`);
  n += 1;
  console.log(`ok  ${msg}`);
}
function env(id: string, over: Partial<Environment>): Environment {
  const at = new Date(now - DAY).toISOString();
  return {
    id, repository: "acme/web", prNumber: 1, sha: "a", branch: "b", status: "ready", deploymentId: null,
    url: null, createdAt: at, updatedAt: at, expiresAt: at, lastActiveAt: at, destroyedAt: null,
    destroyReason: null, error: null, updateGeneration: 1, comments: [], ...over,
  };
}
const ago = (days: number) => new Date(now - days * DAY).toISOString();
const comments = (count: number) => Array.from({ length: count }, (_, i) => ({ at: ago(1), body: `v${i + 1}` }));

const result = pruneEnvironments(
  [
    env("live-old", { createdAt: ago(200), updatedAt: ago(100) }),
    env("removed-59", { status: "destroyed", destroyedAt: ago(59) }),
    env("removed-61", { status: "destroyed", destroyedAt: ago(61) }),
    env("removed-no-date", { status: "destroyed", destroyedAt: null, updatedAt: ago(90) }),
    env("chatty", { comments: comments(15) }),
    env("failed-old", { status: "failed", updatedAt: ago(90) }),
  ],
  now,
);
const ids = result.environments.map((e) => e.id);
check(ids.includes("live-old"), "a running preview is never dropped, however old");
check(ids.includes("removed-59"), "a preview removed 59 days ago is kept");
check(!ids.includes("removed-61"), "a preview removed 61 days ago is dropped");
check(!ids.includes("removed-no-date"), "an old removed preview without a removal date falls back to its last update");
check(ids.includes("failed-old"), "a failed preview (still shown in Admin) is kept");
const chatty = result.environments.find((e) => e.id === "chatty")!;
check(chatty.comments.length === KEEP_COMMENT_VERSIONS, "comment versions capped", chatty.comments.length);
check(chatty.comments[0].body === "v6" && chatty.comments.at(-1)!.body === "v15", "the newest versions are the ones kept");
check(result.removedRecords === 2 && result.trimmedComments === 5, "counts reported", result);
const again = pruneEnvironments(result.environments, now);
check(again.removedRecords === 0 && again.trimmedComments === 0, "running it again changes nothing");

console.log(`\n${n} checks passed`);
