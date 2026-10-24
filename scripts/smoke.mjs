const base = "http://localhost:3000";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { method = "GET", body, headers } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
assert(opened.body.environment.url === "http://localhost:3000/preview/smoke/app/42", opened.body.environment.url);

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
assert(idleReap.body.destroyed.some((env) => env.destroyReason === "idle"), JSON.stringify(idleReap.body));
const afterIdle = await request("/api/environments");
assert(afterIdle.body.deployments.length === 0, "idle deployment still running");

const invalid = await request("/api/events", {
  method: "POST",
  body: { action: "opened", repository: "nope", prNumber: 1, sha: "abc", branch: "main" },
});
assert(invalid.status === 400, `expected 400, got ${invalid.status}`);

for (let number = 1; number <= 5; number += 1) {
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
const sixth = await request("/api/events", {
  method: "POST",
  body: {
    action: "opened",
    repository: "smoke/cap",
    prNumber: 6,
    sha: sha1,
    branch: "feat/cap",
    wait: true,
  },
});
assert(sixth.status === 409, `expected cap 409, got ${sixth.status} ${JSON.stringify(sixth.body)}`);
assert(sixth.body.code === "cap", sixth.body.code);

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
