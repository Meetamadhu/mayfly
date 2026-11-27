/**
 * The first-run setup guide's steps. Run with: npx tsx scripts/test-setup-guide.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { buildSetupSteps, currentStep, isLocalAddress, setupComplete, webhookAddress } = await import("../src/lib/setup-guide");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  const fresh = {
    deployer: "process" as const,
    allowedRepositories: null,
    previewBaseUrl: "http://localhost:3000",
    webhookVerification: "open-in-development" as const,
    githubConnected: false,
    onRender: false,
  };
  const ready = {
    ...fresh,
    allowedRepositories: ["acme/web"],
    previewBaseUrl: "https://previews.acme.dev",
    webhookVerification: "signed" as const,
    githubConnected: true,
  };
  const origin = "https://previews.acme.dev";
  const byId = (steps: ReturnType<typeof buildSetupSteps>) => Object.fromEntries(steps.map((step) => [step.id, step]));

  check("a fresh install has everything left to do, in order, starting with real previews", () => {
    const steps = buildSetupSteps({ config: fresh, previewCount: 0, origin: "http://localhost:3000" });
    assert.deepEqual(
      steps.map((step) => step.id),
      ["runtime", "repositories", "address", "github", "comments", "first"],
    );
    assert.ok(steps.every((step) => !step.done));
    assert.equal(currentStep(steps)?.id, "runtime");
    assert.equal(setupComplete(steps), false);
    assert.equal(steps[0].code, "PREVIEW_RUNTIME=docker");
    assert.ok(steps[0].detail.includes(".env.local"));
    assert.ok(steps[1].detail.includes("needs the step above first"));
  });

  check("a fully set up server is complete, and an unused optional step doesn't hold it open", () => {
    const steps = buildSetupSteps({ config: ready, previewCount: 3, origin });
    assert.ok(steps.every((step) => step.done));
    assert.equal(setupComplete(steps), true);
    assert.equal(currentStep(steps), null);
    assert.ok(steps.every((step) => !step.code), "nothing left to copy");
    const noToken = buildSetupSteps({ config: { ...ready, githubConnected: false }, previewCount: 3, origin });
    assert.equal(byId(noToken).comments.done, false);
    assert.equal(byId(noToken).comments.optional, true);
    assert.equal(setupComplete(noToken), true);
  });

  check("each step follows its own setting", () => {
    const steps = byId(buildSetupSteps({ config: { ...ready, allowedRepositories: [] }, previewCount: 0, origin }));
    assert.equal(steps.runtime.done, true);
    assert.equal(steps.repositories.done, false);
    assert.equal(steps.repositories.code, "PREVIEW_REPOS=owner/name");
    assert.ok(!steps.repositories.detail.includes("needs the step above"));
    assert.equal(steps.address.done, true);
    assert.equal(steps.github.done, true);
    assert.equal(steps.first.done, false);
    const open = byId(buildSetupSteps({ config: { ...ready, webhookVerification: "open-in-development" }, previewCount: 1, origin }));
    assert.equal(open.github.done, false);
    assert.ok(open.github.code?.includes("https://previews.acme.dev/api/webhooks/github"));
    assert.ok(open.github.code?.includes("GITHUB_WEBHOOK_SECRET="));
    assert.equal(open.first.done, true);
  });

  check("the repositories step names who is allowed, and shortens a long list", () => {
    const steps = (names: string[]) => byId(buildSetupSteps({ config: { ...ready, allowedRepositories: names }, previewCount: 0, origin }));
    assert.equal(steps(["a/b"]).repositories.detail, "Allowed: a/b.");
    assert.equal(steps(["a/b", "c/d", "e/f", "g/h", "i/j"]).repositories.detail, "Allowed: a/b, c/d, e/f and 2 more.");
  });

  check("a local address is flagged, and the webhook step says GitHub can't reach it", () => {
    const steps = byId(buildSetupSteps({ config: { ...ready, previewBaseUrl: "http://localhost:3000", webhookVerification: "open-in-development" }, previewCount: 0, origin: "http://localhost:3000" }));
    assert.equal(steps.address.done, false);
    assert.equal(steps.address.code, "PREVIEW_BASE_URL=https://…");
    assert.match(steps.github.detail, /public address/);
    const good = byId(buildSetupSteps({ config: { ...ready, webhookVerification: "open-in-development" }, previewCount: 0, origin }));
    assert.doesNotMatch(good.github.detail, /public address, so finish/);
  });

  check("on Render, settings go to the Render dashboard and a restart is automatic", () => {
    const steps = buildSetupSteps({ config: { ...fresh, onRender: true }, previewCount: 0, origin });
    assert.ok(steps[0].detail.includes("Render dashboard"));
    assert.ok(!steps[0].detail.includes(".env.local"));
    assert.ok(steps[0].detail.includes("Render restarts Mayfly"));
    assert.ok(!steps[0].detail.includes("Then restart Mayfly."));
  });

  check("the hosted demo has no setup to do", () => {
    assert.deepEqual(buildSetupSteps({ config: { ...fresh, deployer: "fake" }, previewCount: 0, origin }), []);
    assert.equal(setupComplete([]), true);
  });

  check("local addresses are recognised, others aren't", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://dev.localhost", "localhost:3000", "not a url 127.0.0.1"]) {
      assert.equal(isLocalAddress(url), true, url);
    }
    for (const url of ["https://previews.acme.dev", "http://192.168.1.20:3000", "https://localhost.example.com"]) {
      assert.equal(isLocalAddress(url), false, url);
    }
  });

  check("the webhook address is the site's address with no doubled slash", () => {
    assert.equal(webhookAddress("https://x.dev"), "https://x.dev/api/webhooks/github");
    assert.equal(webhookAddress("https://x.dev/"), "https://x.dev/api/webhooks/github");
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
