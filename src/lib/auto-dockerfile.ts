import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A repository with no Dockerfile still gets a preview when Mayfly can tell what kind of app it is. This looks at
 * a few files at the top of the repository and writes a Dockerfile for the common cases: Next.js, single-page apps
 * (Vite, Create React App, Vue CLI, Angular), Node.js servers, plain static sites, and Flask or FastAPI apps. A
 * repository's own Dockerfile always wins, and anything unrecognised fails with a message that says what to add.
 *
 * What the generated image has to satisfy is the same as for any preview: listen on $PORT (3000) on 0.0.0.0, and
 * run as user 1000 on a read-only filesystem where only /tmp is writable. It is built with Docker's classic
 * builder, so there are no BuildKit-only features here.
 *
 * Only fixed text and values checked against short lists go into the Dockerfile. The one thing copied from the
 * repository is a start command, and that is written as a JSON array, so it can never end the line it is on.
 */

export interface AutoDockerfile {
  /** What Mayfly took the app for, such as "Next.js". Shown in the build log. */
  label: string;
  dockerfile: string;
  dockerignore: string;
}

/** The few facts the choice is made from. Read from the repository by readRepoShape, or built by hand in tests. */
export interface RepoShape {
  /** File names at the top of the repository, plus "folder/file" for the files inside each top-level folder. */
  paths: string[];
  /** package.json, parsed. Null when there is none or it isn't valid JSON. */
  packageJson: Record<string, unknown> | null;
  /** requirements.txt as text, or null. */
  requirements: string | null;
  /** Procfile as text, or null. */
  procfile: string | null;
}

/** The port every preview app listens on inside its container. */
const PORT = 3000;
const NODE_VERSIONS = [18, 20, 22, 24];
const DEFAULT_NODE = 22;

const DOCKERIGNORE = [".git", "node_modules", ".next", "npm-debug.log", ".env", ".env.*", ""].join("\n");

const NOTE = [
  "# Written by Mayfly because this repository has no Dockerfile.",
  "# To change how it is built, add your own Dockerfile at the top of the repository: that one is used instead.",
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The Node version to build with: the lowest one package.json's "engines" asks for, kept to a supported release. */
export function nodeVersion(engines: unknown): number {
  const range = text(record(engines).node);
  const match = range ? /\d+/.exec(range) : null;
  if (!match) return DEFAULT_NODE;
  const asked = Number(match[0]);
  // The newest supported release at or below what was asked for, or the oldest when that is older than all of them.
  const fit = [...NODE_VERSIONS].reverse().find((version) => version <= asked);
  return fit ?? NODE_VERSIONS[0];
}

function cmd(args: string[]) {
  return `CMD ${JSON.stringify(args)}`;
}

type Manager = "npm" | "yarn" | "pnpm";

function manager(has: (name: string) => boolean): Manager {
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

function installCommand(pm: Manager, has: (name: string) => boolean) {
  if (pm === "pnpm") return "corepack enable && pnpm install --frozen-lockfile";
  if (pm === "yarn") return "corepack enable && yarn install";
  return has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm ci" : "npm install";
}

function runScript(pm: Manager, name: string) {
  return pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
}

const NODE_ENVIRONMENT = ["ENV HOME=/tmp NPM_CONFIG_UPDATE_NOTIFIER=false NEXT_TELEMETRY_DISABLED=1"];

function nodePlan(repo: RepoShape, has: (name: string) => boolean): AutoDockerfile | null {
  const pkg = repo.packageJson ?? {};
  const deps = { ...record(pkg.devDependencies), ...record(pkg.dependencies) };
  const scripts = record(pkg.scripts);
  const pm = manager(has);
  const head = [`FROM node:${nodeVersion(pkg.engines)}-slim`, "WORKDIR /app", "COPY . .", `RUN ${installCommand(pm, has)}`];
  const build = text(scripts.build);

  if ("next" in deps) {
    return {
      label: "Next.js",
      dockerfile: [
        ...NOTE,
        ...head,
        `RUN ${build ? runScript(pm, "build") : "node_modules/.bin/next build"}`,
        ...NODE_ENVIRONMENT,
        "ENV NODE_ENV=production",
        // Next keeps its cache under .next, and the filesystem is read-only when the preview runs: point it at /tmp.
        "RUN rm -rf .next/cache && ln -s /tmp/next-cache .next/cache",
        cmd(["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)]),
        "",
      ].join("\n"),
      dockerignore: DOCKERIGNORE,
    };
  }

  const singlePage = ["vite", "react-scripts", "@vue/cli-service", "@angular/cli"].some((name) => name in deps);
  if (singlePage && build && !("express" in deps)) {
    return {
      label: "single-page app (served as static files)",
      dockerfile: [
        ...NOTE,
        ...head,
        // Only the built files are needed to serve them, so the packages are dropped to keep the image small.
        `RUN ${runScript(pm, "build")} && rm -rf node_modules`,
        "RUN npm install -g serve@14",
        ...NODE_ENVIRONMENT,
        "ENV NO_UPDATE_NOTIFIER=1",
        // The build folder differs between tools (dist, build, dist/<name>/browser), so use the one with an index.html.
        cmd([
          "sh",
          "-c",
          `d=$(find dist build -name index.html 2>/dev/null | head -n 1 | xargs -r dirname); ` +
            `[ -n "$d" ] || { echo "The build made no folder with an index.html in dist or build."; exit 1; }; ` +
            `exec serve -s "$d" -l ${PORT} --no-clipboard`,
        ]),
        "",
      ].join("\n"),
      dockerignore: DOCKERIGNORE,
    };
  }

  const start = text(scripts.start);
  const main = text(pkg.main);
  const entry = ["server.js", "index.js", "app.js", "main.js"].find((file) => has(file));
  const run = start
    ? cmd(["sh", "-c", start])
    : main && has(main.replace(/^\.\//, ""))
      ? cmd(["node", main])
      : entry
        ? cmd(["node", entry])
        : null;
  if (!run) return null;
  return {
    label: "Node.js app",
    dockerfile: [
      ...NOTE,
      ...head,
      ...(build ? [`RUN ${runScript(pm, "build")}`] : []),
      ...NODE_ENVIRONMENT,
      "ENV NODE_ENV=production PATH=/app/node_modules/.bin:$PATH",
      run,
      "",
    ].join("\n"),
    dockerignore: DOCKERIGNORE,
  };
}

/** The command on a Procfile's "web:" line, if there is one. */
export function procfileWeb(procfile: string | null): string | null {
  for (const line of (procfile ?? "").split(/\r?\n/)) {
    const match = /^\s*web\s*:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function pythonPlan(repo: RepoShape, has: (name: string) => boolean): AutoDockerfile | null {
  if (repo.requirements === null) return null;
  const wanted = repo.requirements.toLowerCase();
  const lists = (name: string) => new RegExp(`^\\s*${name}\\b`, "m").test(wanted);
  const head = [
    "FROM python:3.12-slim",
    "WORKDIR /app",
    "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp PIP_DISABLE_PIP_VERSION_CHECK=1",
    "COPY . .",
    "RUN pip install --no-cache-dir -r requirements.txt",
  ];
  const finish = (label: string, extra: string[], run: string): AutoDockerfile => ({
    label,
    dockerfile: [...NOTE, ...head, ...extra, run, ""].join("\n"),
    dockerignore: [DOCKERIGNORE.trimEnd(), "__pycache__", ".venv", "venv", ""].join("\n"),
  });

  const web = procfileWeb(repo.procfile);
  if (web) return finish("Python app (from its Procfile)", [], cmd(["sh", "-c", web]));

  if (lists("fastapi")) {
    const target = (
      [
        ["main.py", "main:app"],
        ["app.py", "app:app"],
        ["app/main.py", "app.main:app"],
      ] as const
    ).find(([file]) => has(file));
    if (!target) return null;
    return finish("FastAPI app", ["RUN pip install --no-cache-dir uvicorn"], cmd(["uvicorn", target[1], "--host", "0.0.0.0", "--port", String(PORT)]));
  }

  if (lists("flask")) {
    const target = (
      [
        ["app.py", "app:app"],
        ["wsgi.py", "wsgi:app"],
        ["main.py", "main:app"],
        ["application.py", "application:app"],
      ] as const
    ).find(([file]) => has(file));
    if (!target) return null;
    return finish("Flask app", ["RUN pip install --no-cache-dir gunicorn"], cmd(["gunicorn", "-b", `0.0.0.0:${PORT}`, target[1]]));
  }
  return null;
}

function staticPlan(): AutoDockerfile {
  return {
    label: "static website",
    dockerfile: [
      ...NOTE,
      "FROM node:22-slim",
      "RUN npm install -g serve@14",
      "WORKDIR /site",
      "COPY . .",
      "ENV HOME=/tmp NO_UPDATE_NOTIFIER=1",
      cmd(["serve", "-l", String(PORT), "--no-clipboard", "."]),
      "",
    ].join("\n"),
    dockerignore: DOCKERIGNORE,
  };
}

/** Decide what to write for a repository, or null when it isn't one of the kinds Mayfly recognises. */
export function planDockerfile(repo: RepoShape): AutoDockerfile | null {
  const names = new Set(repo.paths);
  const has = (name: string) => names.has(name);
  if (repo.packageJson) return nodePlan(repo, has);
  const python = pythonPlan(repo, has);
  if (python) return python;
  if (has("index.html")) return staticPlan();
  return null;
}

/** Whether Mayfly may write a Dockerfile itself. PREVIEW_AUTO_DOCKERFILE=false turns it off. */
export function autoDockerfileEnabled(env: Record<string, string | undefined> = process.env) {
  return !/^(0|false|no|off)$/i.test((env.PREVIEW_AUTO_DOCKERFILE ?? "").trim());
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FOLDERS = 30;
const SKIPPED_FOLDERS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv"]);

/** A regular file's text. Links and anything over 1 MB are ignored, so a repository can't point this at other files. */
async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function readRepoShape(dir: string): Promise<RepoShape> {
  const paths: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  let folders = 0;
  for (const entry of entries) {
    if (entry.isFile()) paths.push(entry.name);
    else if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name) && folders < MAX_FOLDERS) {
      folders += 1;
      for (const inner of await readdir(path.join(dir, entry.name), { withFileTypes: true }).catch(() => [])) {
        if (inner.isFile()) paths.push(`${entry.name}/${inner.name}`);
      }
    }
  }
  const rawPackage = await readSmall(path.join(dir, "package.json"));
  let packageJson: Record<string, unknown> | null = null;
  if (rawPackage !== null) {
    try {
      const parsed: unknown = JSON.parse(rawPackage);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) packageJson = parsed as Record<string, unknown>;
    } catch {
      packageJson = null;
    }
  }
  return {
    paths,
    packageJson,
    requirements: await readSmall(path.join(dir, "requirements.txt")),
    procfile: await readSmall(path.join(dir, "Procfile")),
  };
}

/**
 * Write a Dockerfile (and a .dockerignore, if the repository has none) into a checked-out repository. Returns what
 * was written, or null when there is nothing Mayfly recognises. The caller has already seen that there is no Dockerfile.
 */
export async function writeAutoDockerfile(dir: string): Promise<AutoDockerfile | null> {
  const plan = planDockerfile(await readRepoShape(dir));
  if (!plan) return null;
  await writeFile(path.join(dir, "Dockerfile"), plan.dockerfile);
  const hasIgnore = await lstat(path.join(dir, ".dockerignore")).then(
    () => true,
    () => false,
  );
  if (!hasIgnore) await writeFile(path.join(dir, ".dockerignore"), plan.dockerignore);
  return plan;
}

/** The sentence shown when nothing could be written: what Mayfly knows, and the way out. */
export const NO_DOCKERFILE_MESSAGE =
  "There's no Dockerfile at the top of the repository, and Mayfly couldn't tell what kind of app it is. It can write one itself for Next.js, Vite, React, Vue or Angular apps, Node.js servers with a start script, plain HTML sites, and Flask or FastAPI apps. Otherwise add a Dockerfile that listens on port 3000, and push again.";
