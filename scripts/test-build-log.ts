/**
 * The failed-preview summary and build log on the board's cards. Run with: npx tsx scripts/test-build-log.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { isProblemLine, summarizeFailure } = await import("../src/lib/build-log");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  const log = [
    "Build failed (exit 1).",
    "#8 [4/6] RUN npm ci",
    "#8 2.104 npm warn deprecated inflight@1.0.6",
    "#8 9.871 npm error code ERESOLVE",
    "#8 9.872 npm error ERESOLVE unable to resolve dependency tree",
    "#8 9.880 npm error A complete log of this run can be found in: /root/.npm/_logs/debug.log",
    "#8 DONE 10.2s",
    "",
  ].join("\n");

  check("headline and the last line that names a problem", () => {
    const summary = summarizeFailure(log);
    assert.equal(summary.headline, "Build failed (exit 1).");
    assert.equal(summary.hint, "#8 9.880 npm error A complete log of this run can be found in: /root/.npm/_logs/debug.log");
    assert.equal(summary.log.length, 6, "blank lines dropped, headline not repeated");
  });
  check("a one-line error has no log and no hint", () => {
    const summary = summarizeFailure("docker is not installed on this machine.");
    assert.equal(summary.headline, "docker is not installed on this machine.");
    assert.deepEqual(summary.log, []);
    assert.equal(summary.hint, null);
  });
  check("very long hints are shortened", () => {
    const summary = summarizeFailure(`Build failed (exit 2).\nerror: ${"x".repeat(400)}`);
    assert.ok(summary.hint && summary.hint.length === 178 && summary.hint.endsWith("…"));
  });
  check("problem lines", () => {
    assert.equal(isProblemLine("npm ERR! missing script: build"), true);
    assert.equal(isProblemLine("COPY failed: file not found in build context"), true);
    assert.equal(isProblemLine("Build timed out after 10 minutes."), true);
    assert.equal(isProblemLine("#5 [2/6] WORKDIR /app"), false);
    assert.equal(isProblemLine("Successfully built 1a2b3c"), false);
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
