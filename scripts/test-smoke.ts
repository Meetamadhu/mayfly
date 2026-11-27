/**
 * Smoke checks against a real local web server: a page answering as expected passes, wrong status, missing text,
 * slow and unreachable pages fail with a sentence, a first failure gets one more try, and the settings page's input
 * is checked. Run with: npx tsx scripts/test-smoke.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { asStoredChecks, checksFor, DEFAULT_CHECKS, parseChecks, runChecks, summarize } from "../src/lib/smoke";

async function main() {
let flaky = 0;
const seenHeaders: string[] = [];
const server = createServer((req, res) => {
  seenHeaders.push(String(req.headers["x-mayfly-probe"] ?? ""));
  if (req.url === "/") return void res.end("<h1>Welcome to the shop</h1>");
  if (req.url === "/health") return void res.writeHead(200).end("ok");
  if (req.url === "/broken") return void res.writeHead(500).end("boom");
  if (req.url === "/redirect") return void res.writeHead(302, { location: "/health" }).end();
  if (req.url === "/slow") return; // never answers
  if (req.url === "/flaky") {
    flaky += 1;
    return void res.writeHead(flaky === 1 ? 503 : 200).end("fine now");
  }
  res.writeHead(404).end("nope");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const fast = { retryAfterMs: 10, timeoutMs: 400 };

try {
  // The default: the home page answers 200.
  const home = await runChecks(base, DEFAULT_CHECKS, "abc123", fast);
  assert.equal(home.ok, true);
  assert.equal(home.summary, "GET / answered 200");
  assert.equal(home.sha, "abc123");
  assert.ok(seenHeaders.every((value) => value === ""), "the check must reach the app, never send the gate's probe header");

  // Several checks, one failing.
  const mixed = await runChecks(
    base,
    [
      { path: "/", expectStatus: 200, contains: "Welcome" },
      { path: "/broken", expectStatus: 200 },
      { path: "/missing", expectStatus: 404 },
    ],
    "abc",
    fast,
  );
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.results.map((r) => r.ok), [true, false, true]);
  assert.match(mixed.results[1].problem ?? "", /answered 500, expected 200/);
  assert.equal(mixed.summary, "GET /broken: answered 500, expected 200");

  // Text that must be on the page.
  const missingText = await runChecks(base, [{ path: "/", expectStatus: 200, contains: "Checkout" }], "abc", fast);
  assert.equal(missingText.ok, false);
  assert.match(missingText.results[0].problem ?? "", /doesn't contain “Checkout”/);

  // Redirects are followed.
  assert.equal((await runChecks(base, [{ path: "/redirect", expectStatus: 200 }], "abc", fast)).ok, true);

  // A page that never answers fails with a sentence, and a closed port says it couldn't connect.
  const slow = await runChecks(base, [{ path: "/slow", expectStatus: 200 }], "abc", { retryAfterMs: 10, timeoutMs: 150 });
  assert.equal(slow.ok, false);
  assert.match(slow.results[0].problem ?? "", /no answer within/);
  const closed = await runChecks("http://127.0.0.1:9", [{ path: "/", expectStatus: 200 }], "abc", fast);
  assert.equal(closed.ok, false);
  assert.equal(closed.results[0].problem, "couldn't connect");

  // A failure is tried once more: the first visit to a sleeping preview is also its wake-up.
  const retried = await runChecks(base, [{ path: "/flaky", expectStatus: 200 }], "abc", fast);
  assert.equal(retried.ok, true);
  assert.equal(flaky, 2);

  // The injected fetcher and clock work (used by other tests).
  const fake = await runChecks(
    "http://example.test",
    [{ path: "/x", expectStatus: 200 }],
    "s",
    { fetcher: async () => ({ status: 200, text: async () => "" }), now: () => Date.parse("2026-01-01T00:00:00Z") },
  );
  assert.equal(fake.at, "2026-01-01T00:00:00.000Z");
} finally {
  server.closeAllConnections();
  server.close();
}

assert.equal(summarize([{ path: "/a", expectStatus: 200, ok: true, status: 200, ms: 1 }, { path: "/b", expectStatus: 200, ok: true, status: 200, ms: 1 }]), "2 of 2 checks passed");
assert.match(
  summarize([
    { path: "/a", expectStatus: 200, ok: false, status: 500, ms: 1, problem: "answered 500, expected 200" },
    { path: "/b", expectStatus: 200, ok: false, status: 500, ms: 1, problem: "x" },
  ]),
  /\(and 1 more failed\)$/,
);

// Settings input.
assert.deepEqual(parseChecks(undefined), { ok: true, checks: [] });
assert.deepEqual(parseChecks([{ path: "/health", expectStatus: "204", contains: "ok" }]), { ok: true, checks: [{ path: "/health", expectStatus: 204, contains: "ok" }] });
assert.deepEqual(parseChecks([{ path: "/" }]), { ok: true, checks: [{ path: "/", expectStatus: 200 }] });
for (const bad of [
  [{ path: "health" }],
  [{ path: "//evil.example.com" }],
  [{ path: "/a b" }],
  [{ path: "/", expectStatus: 99 }],
  [{ path: "/", expectStatus: "ok" }],
  [{ path: "/", contains: "x".repeat(101) }],
  [{ path: "/" }, { path: "/" }],
  Array.from({ length: 11 }, (_, i) => ({ path: `/p${i}` })),
  "nope",
]) {
  assert.equal(parseChecks(bad).ok, false, JSON.stringify(bad).slice(0, 60));
}
assert.deepEqual(checksFor(undefined), DEFAULT_CHECKS);
assert.deepEqual(checksFor([]), DEFAULT_CHECKS);
assert.equal(asStoredChecks([{ path: "bad" }]), undefined);
assert.equal(asStoredChecks([{ path: "/ok" }])?.length, 1);

console.log("smoke: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
