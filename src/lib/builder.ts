import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_LIMIT_MS, buildLimits } from "./config";

export interface BuildRequest {
  envId: string;
  repository: string;
  prNumber: number;
  sha: string;
}

const LOG_LINES = 20;
const GIT_LIMIT_MS = 2 * 60 * 1000;
const MB = 1024 * 1024;

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** mayfly-pr-<owner>-<name>-<pr>:<sha8> */
export function imageTag(repository: string, prNumber: number, sha: string) {
  const [owner = "", name = ""] = repository.split("/");
  return `mayfly-pr-${slug(owner)}-${slug(name)}-${prNumber}:${sha.toLowerCase().slice(0, 8)}`;
}

/**
 * Mayfly's own secrets stay out of git and docker child processes. The classic builder is used because it
 * works through a Docker socket proxy (BuildKit needs session and gRPC upgrades the proxy cannot pass) and
 * because it applies --memory and --cpu-quota to every build step.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", DOCKER_BUILDKIT: "0" };
  for (const name of ["MAYFLY_ADMIN_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN"]) delete env[name];
  return env;
}

function run(command: string, args: string[], timeout = 10_000) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

export async function imageExists(tag: string) {
  try {
    await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
    return true;
  } catch {
    return false;
  }
}

export function removeImage(tag: string) {
  return new Promise<void>((resolve) => {
    execFile("docker", ["rmi", "-f", tag], { windowsHide: true, timeout: 30_000, env: childEnv() }, () => resolve());
  });
}

/** Total size in bytes of every file under a directory, symlinks counted as links and never followed. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(full);
      else total += (await lstat(full)).size;
    } catch {
      // removed while walking
    }
  }
  return total;
}

class RepoTooLarge extends Error {}

/** Run git. While it runs the directory is measured, and git is stopped if it grows past the cap. */
function git(args: string[], options: { cwd?: string; watch?: string; maxBytes: number }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd: options.cwd, env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let tooLarge = false;
    let timedOut = false;
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_LIMIT_MS);
    const watcher = options.watch
      ? setInterval(() => {
          void directorySize(options.watch as string).then((size) => {
            if (size > options.maxBytes && !tooLarge) {
              tooLarge = true;
              child.kill("SIGKILL");
            }
          });
        }, 1000)
      : undefined;
    const done = () => {
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
    };
    child.on("error", (error) => {
      done();
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("git is not installed on this machine.") : error);
    });
    child.on("close", (code) => {
      done();
      if (tooLarge) reject(new RepoTooLarge(`Repository is larger than ${Math.round(options.maxBytes / MB)} MB.`));
      else if (timedOut) reject(new Error("git took longer than 2 minutes."));
      else if (code !== 0) reject(new Error(err.trim().split(/\r?\n/).slice(-LOG_LINES).join("\n")));
      else resolve(out);
    });
  });
}

/** Clone the base repository and check out the pull request's exact commit. Returns the full sha. */
async function checkout(repository: string, prNumber: number, sha: string, dir: string, maxBytes: number) {
  const guarded = { watch: dir, maxBytes };
  await git(["clone", "--depth", "1", "--no-checkout", `https://github.com/${repository}.git`, dir], {
    watch: dir,
    maxBytes,
  });
  await git(["fetch", "--depth", "1", "origin", `pull/${prNumber}/head`], { cwd: dir, ...guarded });
  let head = (await git(["rev-parse", "FETCH_HEAD"], { cwd: dir, maxBytes })).trim();
  if (!head.startsWith(sha)) {
    // The pull request moved on, or the commit is reachable some other way. Only a full sha can be fetched by name.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`Pull request head is ${head.slice(0, 8)}, not ${sha.slice(0, 8)}.`);
    }
    await git(["fetch", "--depth", "1", "origin", sha], { cwd: dir, ...guarded });
    head = (await git(["rev-parse", "FETCH_HEAD"], { cwd: dir, maxBytes })).trim();
    if (!head.startsWith(sha)) throw new Error(`Could not fetch commit ${sha.slice(0, 8)}.`);
  }
  await git(["-c", "advice.detachedHead=false", "checkout", "--detach", head], { cwd: dir, ...guarded });
  return head;
}

async function hasDockerfile(dir: string) {
  try {
    return (await lstat(path.join(dir, "Dockerfile"))).isFile();
  } catch {
    return false;
  }
}

function dockerBuild(tag: string, envId: string, dir: string) {
  const limits = buildLimits();
  return new Promise<void>((resolve, reject) => {
    const tail: string[] = [];
    let partial = "";
    const take = (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) tail.push(line);
      }
      if (tail.length > LOG_LINES) tail.splice(0, tail.length - LOG_LINES);
    };
    const finish = (prefix: string) => {
      if (partial.trim()) tail.push(partial);
      return new Error([prefix, ...tail.slice(-LOG_LINES)].join("\n"));
    };

    const child = spawn(
      "docker",
      [
        "build",
        "--force-rm",
        "--memory",
        limits.memory,
        "--memory-swap",
        limits.memory,
        "--cpu-period",
        "100000",
        "--cpu-quota",
        String(Math.round(limits.cpus * 100000)),
        "--label",
        "mayfly.image=1",
        "--label",
        `mayfly.image.env=${envId}`,
        "-t",
        tag,
        ".",
      ],
      { cwd: dir, windowsHide: true, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        child.kill("SIGKILL");
      }
    }, BUILD_LIMIT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("docker is not installed on this machine.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(finish("Build timed out after 10 minutes."));
      else if (code !== 0) reject(finish(`Build failed (exit ${code}).`));
      else resolve();
    });
  });
}

/** Builds that wait for or hold a slot, by environment id. The reaper must not call these previews stuck. */
interface BuildRegistry {
  active: number;
  waiting: (() => void)[];
  envs: Map<string, number>;
}

const holder = globalThis as unknown as { __mayflyBuildState?: BuildRegistry };
const registry: BuildRegistry = (holder.__mayflyBuildState ??= { active: 0, waiting: [], envs: new Map() });

export function isBuilding(envId: string) {
  return (registry.envs.get(envId) ?? 0) > 0;
}

async function acquireSlot(tag: string) {
  const limit = buildLimits().maxBuilds;
  if (registry.active >= limit) {
    console.log(`Waiting for a build slot: ${tag} (${registry.waiting.length + 1} queued, ${registry.active} running)`);
    await new Promise<void>((resolve) => registry.waiting.push(resolve));
  } else {
    registry.active += 1;
  }
  // A finished build hands its slot straight to the next in line, so `active` stays counted for it.
  return () => {
    const next = registry.waiting.shift();
    if (next) next();
    else registry.active -= 1;
  };
}

const inflight = ((globalThis as unknown as { __mayflyBuilds?: Map<string, Promise<string>> }).__mayflyBuilds ??= new Map());

/** Build the pull request's own Dockerfile. Callers that ask for the same image at once share one build. */
export function buildImage(request: BuildRequest): Promise<string> {
  const tag = imageTag(request.repository, request.prNumber, request.sha);
  const running = inflight.get(tag);
  if (running) return running;
  const work = (async () => {
    registry.envs.set(request.envId, (registry.envs.get(request.envId) ?? 0) + 1);
    const release = await acquireSlot(tag);
    let dir: string | undefined;
    try {
      const limits = buildLimits();
      const maxBytes = limits.maxRepoMb * MB;
      const started = Date.now();
      dir = await mkdtemp(path.join(os.tmpdir(), "mayfly-build-"));
      const source = path.join(dir, "source");
      console.log(`Building ${tag} from ${request.repository}#${request.prNumber}`);
      await checkout(request.repository, request.prNumber, request.sha, source, maxBytes);
      if ((await directorySize(source)) > maxBytes) {
        throw new Error(`Repository is larger than ${limits.maxRepoMb} MB.`);
      }
      if (!(await hasDockerfile(source))) throw new Error("No Dockerfile at repo root");
      await dockerBuild(tag, request.envId, source);

      const size = Number((await run("docker", ["image", "inspect", "--format", "{{.Size}}", tag]).catch(() => "0")).trim());
      if (size > limits.maxImageMb * MB) {
        await removeImage(tag);
        throw new Error(`Image is ${Math.round(size / MB)} MB. The limit is ${limits.maxImageMb} MB.`);
      }
      console.log(`Built ${tag} in ${Math.round((Date.now() - started) / 1000)}s (${Math.round(size / MB)} MB)`);
      return tag;
    } finally {
      release();
      const left = (registry.envs.get(request.envId) ?? 1) - 1;
      if (left > 0) registry.envs.set(request.envId, left);
      else registry.envs.delete(request.envId);
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  })();
  inflight.set(tag, work);
  const clear = () => {
    if (inflight.get(tag) === work) inflight.delete(tag);
  };
  work.then(clear, clear);
  return work;
}
