import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_LIMIT_MS } from "./config";

export interface BuildRequest {
  envId: string;
  repository: string;
  prNumber: number;
  sha: string;
}

const LOG_LINES = 20;
const GIT_LIMIT_MS = 2 * 60 * 1000;

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** mayfly-pr-<owner>-<name>-<pr>:<sha8> */
export function imageTag(repository: string, prNumber: number, sha: string) {
  const [owner = "", name = ""] = repository.split("/");
  return `mayfly-pr-${slug(owner)}-${slug(name)}-${prNumber}:${sha.toLowerCase().slice(0, 8)}`;
}

/** Mayfly's own secrets stay out of git and docker child processes. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", DOCKER_BUILDKIT: "1" };
  for (const name of ["MAYFLY_ADMIN_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_TOKEN"]) delete env[name];
  return env;
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? GIT_LIMIT_MS, windowsHide: true, env: childEnv(), maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`${command} is not installed on this machine.`));
          return;
        }
        reject(new Error(String(stderr || error.message).trim().split(/\r?\n/).slice(-LOG_LINES).join("\n")));
      },
    );
  });
}

export async function imageExists(tag: string) {
  try {
    await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function removeImage(tag: string) {
  return new Promise<void>((resolve) => {
    execFile("docker", ["rmi", "-f", tag], { windowsHide: true, timeout: 30_000 }, () => resolve());
  });
}

/** Clone the base repository and check out the pull request's exact commit. Returns the full sha. */
async function checkout(repository: string, prNumber: number, sha: string, dir: string) {
  await run("git", ["clone", "--depth", "1", "--no-checkout", `https://github.com/${repository}.git`, dir]);
  await run("git", ["fetch", "--depth", "1", "origin", `pull/${prNumber}/head`], { cwd: dir });
  let head = (await run("git", ["rev-parse", "FETCH_HEAD"], { cwd: dir })).trim();
  if (!head.startsWith(sha)) {
    // The pull request moved on, or the commit is reachable some other way. Only a full sha can be fetched by name.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`Pull request head is ${head.slice(0, 8)}, not ${sha.slice(0, 8)}.`);
    }
    await run("git", ["fetch", "--depth", "1", "origin", sha], { cwd: dir });
    head = (await run("git", ["rev-parse", "FETCH_HEAD"], { cwd: dir })).trim();
    if (!head.startsWith(sha)) throw new Error(`Could not fetch commit ${sha.slice(0, 8)}.`);
  }
  await run("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", head], { cwd: dir });
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
      const lines = tail.slice(-LOG_LINES);
      return new Error([prefix, ...lines].join("\n"));
    };

    const child = spawn(
      "docker",
      [
        "build",
        "--progress=plain",
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

const inflight = ((globalThis as unknown as { __mayflyBuilds?: Map<string, Promise<string>> }).__mayflyBuilds ??= new Map());

/** Build the pull request's own Dockerfile. Callers that ask for the same image at once share one build. */
export function buildImage(request: BuildRequest): Promise<string> {
  const tag = imageTag(request.repository, request.prNumber, request.sha);
  const running = inflight.get(tag);
  if (running) return running;
  const work = (async () => {
    const started = Date.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), "mayfly-build-"));
    try {
      const source = path.join(dir, "source");
      console.log(`Building ${tag} from ${request.repository}#${request.prNumber}`);
      await checkout(request.repository, request.prNumber, request.sha, source);
      if (!(await hasDockerfile(source))) throw new Error("No Dockerfile at repo root");
      await dockerBuild(tag, request.envId, source);
      console.log(`Built ${tag} in ${Math.round((Date.now() - started) / 1000)}s`);
      return tag;
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  })();
  inflight.set(tag, work);
  const clear = () => {
    if (inflight.get(tag) === work) inflight.delete(tag);
  };
  work.then(clear, clear);
  return work;
}
