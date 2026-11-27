/**
 * The plain-language "what to try" under a failed preview. Run with: npx tsx scripts/test-failure-help.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { explainFailure } = await import("../src/lib/failure-help");
  const { NO_DOCKERFILE_MESSAGE } = await import("../src/lib/auto-dockerfile");
  const { appStartError } = await import("../src/lib/gate-logs");
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const title = (error: string) => explainFailure(error)?.title;

  check("every message Mayfly writes itself is recognised", () => {
    assert.equal(title(NO_DOCKERFILE_MESSAGE), "Mayfly doesn't know how to run this app");
    assert.equal(
      title("This repository isn't on Mayfly's list of allowed repositories (PREVIEW_REPOS). Ask an admin to add it."),
      "This repository isn't allowed yet",
    );
    assert.equal(title("Repository is larger than 200 MB."), "The repository is too big");
    assert.equal(title("The repository is bigger than Mayfly's 200 MB limit."), "The repository is too big");
    assert.equal(title("The built app is 1500 MB, more than Mayfly's 1024 MB limit. Try making the Docker image smaller."), "The built app is too big");
    assert.equal(title("Build timed out after 10 minutes."), "The build took too long");
    assert.equal(title("Downloading the code took longer than 2 minutes. Push again to retry."), "Downloading the code took too long");
    assert.equal(title("A newer commit (abc12345) was pushed while this one (def67890) was being built. Mayfly builds the newest one."), "A newer commit arrived while this one was building");
    assert.equal(title("git is not installed on this machine."), "The server can't build previews right now");
    assert.equal(title("docker is not installed on this machine."), "The server can't build previews right now");
  });

  check("an app that never answered says to listen on port 3000", () => {
    const text = appStartError("Preview process returned 502.", ["Error: Cannot find module 'express'", "    at Module._load"]);
    assert.equal(text.split("\n")[0], "The app didn't start listening on port 3000. (Preview process returned 502.)");
    assert.equal(title(text), "The app started, but nothing answered on port 3000");
    assert.ok(explainFailure(text)?.steps.some((step) => step.includes("PORT")));
    assert.equal(title("Preview app did not wake."), "The app started, but nothing answered on port 3000");
  });

  check("what the app printed follows the headline, newest 40 lines, blanks dropped", () => {
    const lines = Array.from({ length: 100 }, (_, index) => (index % 10 === 0 ? "" : `line ${index}`));
    const out = appStartError("no answer", lines).split("\n");
    assert.equal(out.length, 41);
    assert.equal(out.at(-1), "line 99");
    assert.ok(!out.slice(1).some((line) => line.trim() === ""));
    assert.equal(appStartError("  a \n b  ", []), "The app didn't start listening on port 3000. (a b)");
  });

  check("common build failures get specific advice", () => {
    const wrap = (...log: string[]) => ["Build failed (exit 1).", ...log].join("\n");
    assert.equal(title("Build failed (exit 137)."), "The build ran out of memory");
    assert.equal(title(wrap("#9 12.3 Killed")), "The build ran out of memory");
    assert.equal(title(wrap("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")), "The build ran out of memory");
    assert.equal(title(wrap("#4 ERROR: pull access denied for nopenope, repository does not exist")), "The Dockerfile's base image couldn't be found");
    assert.equal(title(wrap("COPY failed: file not found in build context or excluded by .dockerignore")), "The Dockerfile copies a file that isn't there");
    assert.equal(title(wrap("npm error Missing script: \"build\"")), "package.json has no script the build needs");
    assert.equal(title(wrap("npm ERR! code ERESOLVE", "npm ERR! ERESOLVE could not resolve")), "The packages conflict with each other");
    assert.equal(title(wrap("Error: Cannot find module 'left-pad'")), "The code needs a package that isn't installed");
    assert.equal(title(wrap("Module not found: Error: Can't resolve './missing'")), "The code needs a package that isn't installed");
    assert.equal(title(wrap("gyp ERR! build error", "gyp ERR! not ok")), "A package needs build tools the image doesn't have");
    assert.equal(title(wrap("error: command 'gcc' failed with exit status 1")), "A package needs build tools the image doesn't have");
    assert.equal(title(wrap("ERROR: No matching distribution found for nothing==9")), "A Python package couldn't be found");
    assert.equal(title(wrap("Error: EACCES: permission denied, mkdir '/app/.cache'")), "The app tried to write somewhere it isn't allowed to");
    assert.equal(title(wrap("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), "Mayfly couldn't download the code");
    assert.equal(title(wrap("remote: Repository not found.")), "Mayfly couldn't download the code");
  });

  check("an unrecognised build failure still gets the general steps, with the build log named", () => {
    const help = explainFailure("Build failed (exit 2).\nsomething nobody has seen before");
    assert.equal(help?.title, "The build stopped with an error");
    assert.ok(help?.steps.some((step) => step.includes("build log")));
    assert.ok(help?.steps.some((step) => step.includes("docker build")));
  });

  check("harmless words in a log don't trigger advice", () => {
    // These appear in healthy installs and builds: a warning about peers or a progress line must not blame the user.
    assert.equal(title("Build failed (exit 1)."), "The build stopped with an error");
    assert.equal(title("Build failed (exit 1).\nnpm warn peer dep missing: react@18"), "The build stopped with an error");
    assert.equal(title("Build failed (exit 1).\n#5 [2/6] RUN apt-get install gcc"), "The build stopped with an error");
    assert.equal(title("Build failed (exit 1).\nThe process was killed by a signal"), "The build stopped with an error");
  });

  check("nothing to say about no error or a message it doesn't know", () => {
    assert.equal(explainFailure(null), null);
    assert.equal(explainFailure(undefined), null);
    assert.equal(explainFailure(""), null);
    assert.equal(explainFailure("Failed."), null);
    assert.equal(explainFailure("Something odd happened."), null);
  });

  check("advice never repeats text from the log", () => {
    const secretish = "AKIA_super_secret_token_12345";
    const help = explainFailure(`Build failed (exit 1).\nnpm error Missing script: "build" ${secretish}`);
    assert.ok(help);
    assert.ok(!JSON.stringify(help).includes(secretish));
  });

  check("every rule has a title and at least one step, with no duplicates", () => {
    const samples = [
      NO_DOCKERFILE_MESSAGE,
      "Build failed (exit 137).",
      "Build failed (exit 1).",
      appStartError("x", []),
      "Build timed out after 10 minutes.",
    ];
    for (const sample of samples) {
      const help = explainFailure(sample);
      assert.ok(help && help.title.length > 3 && help.steps.length > 0, sample);
      assert.equal(new Set(help.steps).size, help.steps.length, "no repeated steps");
    }
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
