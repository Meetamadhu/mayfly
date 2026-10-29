import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const base = "http://localhost:3000";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Reads a key from the environment first, then from .env.local, so the smoke test uses the server's values.
function setting(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = raw.split(/\r?\n/).find((item) => item.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : "";
  } catch {
    return "";
  }
}

const adminToken = setting("MAYFLY_ADMIN_TOKEN");
assert(adminToken, "Set MAYFLY_ADMIN_TOKEN in .env.local (or the environment) before running the smoke test.");

async function request(path, { method = "GET", body, headers } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signatureHeaders = {};
  if (payload && path.startsWith("/api/webhooks/github")) {
    const secret = setting("GITHUB_WEBHOOK_SECRET");
    if (secret) {
      signatureHeaders["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    }
  }
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      ...signatureHeaders,
      ...headers,
    },
    body: payload,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const unauthenticated = await fetch(`${base}/api/reaper`, { method: "POST" });
assert(unauthenticated.status === 401, `reaper without a token returned ${unauthenticated.status}`);
const wrongToken = await fetch(`${base}/api/reaper`, { method: "POST", headers: { Authorization: "Bearer wrong-token" } });
assert(wrongToken.status === 401, `reaper with a wrong token returned ${wrongToken.status}`);

const opened = await request("/api/events", {
  method: "POST",
  body: {
    action: "opened",
    repository: "smoke/app",
    prNumber: 42,
    sha: sha1,
    branch: "feat/lifetime",
    ttlMinutes: 480,
    wait: true,
  },
});
assert(opened.status === 200, `open failed ${opened.status} ${JSON.stringify(opened.body)}`);
assert(opened.body.environment.status === "ready", "open did not become ready");
assert(opened.body.environment.url.endsWith("/p/smoke/app/42"), opened.body.environment.url);
const previewPage = await fetch(opened.body.environment.url);
assert(previewPage.status === 200, `preview process status ${previewPage.status}`);
assert((await previewPage.text()).includes(sha1), "preview process did not serve the opened commit");

const listed = await request("/api/environments");
assert(listed.body.summary.live === 1, `expected 1 live, got ${listed.body.summary.live}`);
assert(listed.body.deployments.length === 1, "deployment ledger missing the preview");

const updated = await request("/api/events", {
  method: "POST",
  body: {
    action: "synchronize",
    repository: "smoke/app",
    prNumber: 42,
    sha: sha2,
    branch: "feat/lifetime",
    wait: true,
  },
});
assert(updated.status === 200, `update failed ${JSON.stringify(updated.body)}`);
assert(updated.body.environment.sha === sha2, "sha did not change");
assert(updated.body.environment.status === "ready", "update did not return to ready");
const updatedPage = await fetch(updated.body.environment.url);
assert((await updatedPage.text()).includes(sha2), "preview process did not serve the updated commit");

const afterUpdate = await request("/api/environments");
assert(afterUpdate.body.deployments[0].sha === sha2, "deployed sha was not updated");
assert(afterUpdate.body.deployments.length === 1, "update created a second deployment");

const closed = await request("/api/events", {
  method: "POST",
  body: {
    action: "closed",
    repository: "smoke/app",
    prNumber: 42,
    sha: sha2,
    branch: "feat/lifetime",
    merged: true,
    wait: true,
  },
});
assert(closed.status === 200, `close failed ${JSON.stringify(closed.body)}`);
assert(closed.body.environment.status === "destroyed", "close did not destroy");
assert(closed.body.environment.destroyReason === "merged", closed.body.environment.destroyReason);

const afterClose = await request("/api/environments");
assert(afterClose.body.deployments.length === 0, "deployment still billed after merge");
assert(afterClose.body.summary.live === 0, "live count after merge");
const mergedPage = await fetch(opened.body.environment.url);
assert(mergedPage.status === 404, `preview still served after merge (${mergedPage.status})`);

const expired = await request("/api/events", {
  method: "POST",
  body: {
    action: "opened",
    repository: "smoke/app",
    prNumber: 7,
    sha: sha1,
    branch: "feat/ttl",
    ttlMinutes: 0,
    wait: true,
  },
});
assert(expired.body.environment.status === "ready", "ttl 0 preview did not become ready");
const reaped = await request("/api/reaper", { method: "POST" });
assert(reaped.body.destroyed.length === 1, `reaper destroyed ${reaped.body.destroyed.length}`);
assert(reaped.body.destroyed[0].destroyReason === "expired", reaped.body.destroyed[0].destroyReason);
const afterExpire = await request("/api/environments");
assert(afterExpire.body.deployments.length === 0, "expired deployment still running");

const idle = await request("/api/events", {
  method: "POST",
  body: {
    action: "opened",
    repository: "smoke/app",
    prNumber: 8,
    sha: sha1,
    branch: "feat/idle",
    ttlMinutes: 480,
    wait: true,
  },
});
const idleId = idle.body.environment.id;
const marked = await request(`/api/environments/${idleId}?action=idle`, { method: "POST" });
assert(marked.status === 200, `mark idle failed ${JSON.stringify(marked.body)}`);
const idleReap = await request("/api/reaper", { method: "POST" });
assert(!idleReap.body.destroyed.some((env) => env.id === idleId), `idle preview was deleted ${JSON.stringify(idleReap.body)}`);
const afterIdle = await request(`/api/environments/${idleId}`);
assert(afterIdle.body.environment.status === "ready", "idle preview was not left running");
const idleStopped = await request(`/api/environments/${idleId}?action=destroy&wait=1`, { method: "POST" });
assert(idleStopped.status === 200, `idle cleanup failed ${JSON.stringify(idleStopped.body)}`);

const invalid = await request("/api/events", {
  method: "POST",
  body: { action: "opened", repository: "nope", prNumber: 1, sha: "abc", branch: "main" },
});
assert(invalid.status === 400, `expected 400, got ${invalid.status}`);

for (let number = 1; number <= 10; number += 1) {
  const created = await request("/api/events", {
    method: "POST",
    body: {
      action: "opened",
      repository: "smoke/cap",
      prNumber: number,
      sha: sha1,
      branch: "feat/cap",
      wait: true,
    },
  });
  assert(created.status === 200, `cap seed ${number} failed ${JSON.stringify(created.body)}`);
}
const eleventh = await request("/api/events", {
  method: "POST",
  body: {
    action: "opened",
    repository: "smoke/cap",
    prNumber: 11,
    sha: sha1,
    branch: "feat/cap",
    wait: true,
  },
});
assert(eleventh.status === 409, `expected cap 409, got ${eleventh.status} ${JSON.stringify(eleventh.body)}`);
assert(eleventh.body.code === "cap", eleventh.body.code);

const webhook = await request("/api/webhooks/github", {
  method: "POST",
  headers: { "x-github-event": "pull_request" },
  body: {
    action: "closed",
    repository: { full_name: "smoke/cap" },
    pull_request: { number: 1, merged: false, head: { sha: sha1, ref: "feat/cap" } },
  },
});
assert(webhook.status === 200, `webhook failed ${webhook.status} ${JSON.stringify(webhook.body)}`);

const ping = await request("/api/webhooks/github", {
  method: "POST",
  headers: { "x-github-event": "ping" },
  body: { zen: "design for failure" },
});
assert(ping.body.ignored === true, "ping was not ignored");

const draining = await request("/api/environments");
for (const env of draining.body.environments) {
  if (["provisioning", "ready", "updating", "destroying"].includes(env.status)) {
    const destroyed = await request(`/api/environments/${env.id}?action=destroy&wait=1`, { method: "POST" });
    assert(destroyed.status === 200, `drain failed ${env.id} ${JSON.stringify(destroyed.body)}`);
  }
}
const empty = await request("/api/environments");
assert(empty.body.summary.live === 0, `expected empty ledger, live=${empty.body.summary.live}`);
assert(empty.body.deployments.length === 0, "deployments left after drain");

console.log("smoke ok");
