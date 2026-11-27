/**
 * Audit log CSV. Run with: npx tsx scripts/test-audit.ts
 */
import assert from "node:assert/strict";
import { auditRows, auditToCsv } from "../src/lib/audit";
import type { Environment } from "../src/lib/types";

function env(partial: Partial<Environment> & Pick<Environment, "id" | "repository" | "prNumber">): Environment {
  return {
    sha: "aaaaaaaa",
    branch: "main",
    status: "ready",
    deploymentId: null,
    url: "http://localhost/p/x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    destroyedAt: null,
    destroyReason: null,
    error: null,
    updateGeneration: 0,
    comments: [],
    ...partial,
  };
}

const rows = auditRows([
  env({
    id: "a",
    repository: "acme/web",
    prNumber: 1,
    author: "ann",
    events: [
      { at: "2026-01-02T10:00:00.000Z", type: "opened" },
      { at: "2026-01-02T10:01:00.000Z", type: "ready" },
    ],
  }),
  env({
    id: "b",
    repository: "acme/api",
    prNumber: 2,
    status: "destroyed",
    events: [{ at: "2026-01-03T10:00:00.000Z", type: "destroyed", detail: "merged" }],
  }),
]);

assert.equal(rows.length, 2, "destroyed previews are skipped by default");
assert.equal(rows[0].repository, "acme/web");
assert.ok(rows[0].at >= rows[1].at);

const withDestroyed = auditRows(
  [
    env({
      id: "b",
      repository: "acme/api",
      prNumber: 2,
      status: "destroyed",
      events: [{ at: "2026-01-03T10:00:00.000Z", type: "destroyed", detail: "merged" }],
    }),
  ],
  { includeDestroyed: true },
);
assert.equal(withDestroyed.length, 1);

const csv = auditToCsv(rows);
assert.ok(csv.startsWith("When (UTC),"));
assert.ok(csv.includes("acme/web"));
assert.ok(csv.includes("Ready to view"));
assert.equal(auditToCsv([{ ...rows[0], detail: "=1+1", repository: "+Danger" }]).includes("'=1+1"), true);
assert.equal(auditToCsv([{ ...rows[0], repository: "+Danger" }]).includes("'+Danger"), true);

console.log("audit: ok");
