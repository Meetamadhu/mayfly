import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildImage, imageExists, imageTag, removeImage } from "./builder";
import { buildsPullRequests, getConfig, previewRuntime, repositoryAllowed } from "./config";
import { createExclusive, dataDir, readJson, writeJson } from "./store";
import type { DeploymentRecord } from "./types";

/**
 * The only cloud boundary. Replace getDeployer() when a real target is chosen.
 * provision, update, and destroy must be safe to call more than once.
 */
export interface DeployRequest {
  envId: string;
  repository: string;
  prNumber: number;
  sha: string;
  branch: string;
  deploymentId?: string | null;
}

export interface Deployment {
  deploymentId: string;
  url: string;
}

export interface Deployer {
  provision(input: DeployRequest): Promise<Deployment>;
  update(input: DeployRequest): Promise<Deployment>;
  /** Start the preview again when its process is gone. Leave a running one alone. */
  revive(input: DeployRequest): Promise<Deployment>;
  destroy(input: { deploymentId: string }): Promise<void>;
  list(): Promise<DeploymentRecord[]>;
}

interface DeployFile {
  deployments: DeploymentRecord[];
}

const exclusive = createExclusive("__previewDeployLock");

function deployFile() {
  return path.join(dataDir(), "deployments.json");
}

export function previewUrl(repository: string, prNumber: number) {
  const [owner, name] = repository.split("/");
  const base = getConfig().previewBaseUrl;
  return `${base}/preview/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${prNumber}`;
}

/** The link people open: served by Mayfly at /p/<owner>/<name>/<pr>, which forwards to the local gate. */
export function publicPreviewUrl(repository: string, prNumber: number) {
  const [owner, name] = repository.split("/");
  const base = getConfig().previewBaseUrl;
  return `${base}/p/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${prNumber}`;
}

async function pause() {
  const delay = getConfig().fakeDelayMs;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function loadDeployments(): Promise<DeployFile> {
  const file = await readJson<DeployFile>(deployFile(), { deployments: [] });
  if (!Array.isArray(file.deployments)) return { deployments: [] };
  return file;
}

const fakeDeployer: Deployer = {
  async provision(input) {
    await pause();
    return exclusive(async () => {
      const file = await loadDeployments();
      const now = new Date().toISOString();
      const record: DeploymentRecord = {
        deploymentId: `dep_${input.envId}`,
        repository: input.repository,
        prNumber: input.prNumber,
        sha: input.sha,
        branch: input.branch,
        url: previewUrl(input.repository, input.prNumber),
        createdAt: now,
        updatedAt: now,
      };
      file.deployments = file.deployments.filter((item) => item.deploymentId !== record.deploymentId);
      file.deployments.push(record);
      await writeJson(deployFile(), file);
      return { deploymentId: record.deploymentId, url: record.url };
    });
  },

  async revive(input) {
    return this.update(input);
  },

  async update(input) {
    await pause();
    const deploymentId = input.deploymentId || `dep_${input.envId}`;
    return exclusive(async () => {
      const file = await loadDeployments();
      const now = new Date().toISOString();
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      if (!existing) {
        file.deployments.push({
          deploymentId,
          repository: input.repository,
          prNumber: input.prNumber,
          sha: input.sha,
          branch: input.branch,
          url: previewUrl(input.repository, input.prNumber),
          createdAt: now,
          updatedAt: now,
        });
      } else {
        existing.sha = input.sha;
        existing.branch = input.branch;
        existing.updatedAt = now;
      }
      await writeJson(deployFile(), file);
      return {
        deploymentId,
        url: previewUrl(input.repository, input.prNumber),
      };
    });
  },

  async destroy(input) {
    await pause();
    await exclusive(async () => {
      const file = await loadDeployments();
      file.deployments = file.deployments.filter((item) => item.deploymentId !== input.deploymentId);
      await writeJson(deployFile(), file);
    });
  },

  async list() {
    const file = await loadDeployments();
    return file.deployments.map((item) => ({
      ...item,
      url: previewUrl(item.repository, item.prNumber),
    }));
  },
};

const FIRST_PORT = 4300;
const PORT_SPAN = 100;

function deploymentIdFor(envId: string) {
  return `proc_${envId}`;
}

/** Where the gate listens. Only this machine can reach it; the board shows publicPreviewUrl instead. */
function previewListenUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a saved pid is still the preview gate. After a restart, a pid in the ledger can belong to some other
 * process, and treating that as the gate would skip restoring the preview, or signal the wrong process.
 */
function gateAlive(pid: number) {
  if (!processAlive(pid)) return false;
  if (process.platform !== "linux") return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("preview-gate.mjs");
  } catch {
    return false;
  }
}

/** Signal the gate's process group (negative pid). Falls back to the bare pid if there is no such group. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      // ESRCH or EPERM: try the next target
    }
  }
  return false;
}

async function killProcess(pid: number) {
  if (process.platform !== "win32") {
    // startPreview() spawns the gate detached, so on Linux it leads its own process group.
    // The gate cleans up its app group on SIGTERM; SIGKILL on the group is the backstop.
    if (!signalGroup(pid, "SIGTERM")) return;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && processAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    signalGroup(pid, "SIGKILL");
    return;
  }
  // Windows has no process groups. taskkill /T walks the tree; wait for it before the caller reuses the ports.
  await new Promise<void>((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pairFree(port: number) {
  return (await portFree(port)) && (await portFree(port + 1000));
}

async function claimPort(preferred?: number) {
  if (preferred && (await pairFree(preferred))) return preferred;
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SPAN; port += 1) {
    if (await pairFree(port)) return port;
  }
  throw new Error("No free preview port.");
}

/**
 * The only server variables a preview process may see: PATH, NODE_ENV and PREVIEW_*.
 * Everything else (GITHUB_TOKEN, MAYFLY_GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, MAYFLY_ADMIN_TOKEN, ...) stays out of previews.
 * On Windows a few system variables are also passed, because Node's networking fails in a child without them.
 */
// DOCKER_HOST is how the gate reaches a Docker socket proxy. It is not an app secret, and apps run in containers.
const PASS_THROUGH = ["PATH", "NODE_ENV", "DOCKER_HOST"];
const WINDOWS_PASS_THROUGH = ["SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT"];

function previewBaseEnv(): NodeJS.ProcessEnv {
  // Built up from the allow-list below; NODE_ENV is copied when the server has it.
  const env = {} as NodeJS.ProcessEnv;
  const names = process.platform === "win32" ? [...PASS_THROUGH, ...WINDOWS_PASS_THROUGH] : PASS_THROUGH;
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("PREVIEW_") && value !== undefined) env[name] = value;
  }
  return env;
}

const PREVIEW_IMAGE = "mayfly-preview:local";

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    // The classic builder works through a Docker socket proxy; BuildKit does not.
    const env = { ...process.env, DOCKER_BUILDKIT: "0" };
    execFile(command, args, { windowsHide: true, cwd: process.cwd(), env }, (error, _stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).toString().trim()));
      else resolve();
    });
  });
}

let imageReady: Promise<void> | null = null;

function ensurePreviewImage() {
  if (!imageReady) {
    imageReady = run("docker", ["build", "-f", "docker/preview.Dockerfile", "-t", PREVIEW_IMAGE, "."]).catch((error) => {
      imageReady = null;
      throw error;
    });
  }
  return imageReady;
}

function isDemoRequest(input: DeployRequest) {
  const demo = getConfig().demo;
  return Boolean(demo && demo.repository === input.repository.toLowerCase() && demo.prNumber === input.prNumber);
}

/**
 * The image a preview runs. Process mode needs none. In Docker mode the demo keeps the placeholder app, and
 * every other pull request builds its own Dockerfile from an allow-listed repository. This runs before the
 * deployer lock is taken, so a long build does not block the board.
 */
async function prepareImage(input: DeployRequest): Promise<string> {
  if (previewRuntime() !== "docker") return PREVIEW_IMAGE;
  if (!buildsPullRequests() || isDemoRequest(input)) {
    await ensurePreviewImage();
    return PREVIEW_IMAGE;
  }
  if (!repositoryAllowed(input.repository)) throw new Error("Repository not allowed");
  const tag = imageTag(input.repository, input.prNumber, input.sha);
  // The tag names the commit, so an image that already exists is this commit's code. Waking never rebuilds it.
  if (await imageExists(tag)) return tag;
  return buildImage({ envId: input.envId, repository: input.repository, prNumber: input.prNumber, sha: input.sha });
}

/** Built images are removed with their preview. The placeholder image is shared and stays. */
function builtImage(image: string | undefined) {
  return image && image !== PREVIEW_IMAGE ? image : undefined;
}

/** True when another deployment record still points at this built image tag (same PR+commit). */
function imageUsedElsewhere(
  deployments: DeploymentRecord[],
  image: string,
  exceptDeploymentId: string,
) {
  return deployments.some(
    (item) => item.deploymentId !== exceptDeploymentId && builtImage(item.image) === image,
  );
}

function removeContainer(appPort: number) {
  return new Promise<void>((resolve) => {
    execFile("docker", ["rm", "-f", `mayfly-app-${appPort}`], { windowsHide: true }, () => resolve());
  });
}

function startPreview(port: number, input: DeployRequest, image: string) {
  const appPort = port + 1000;
  const docker = previewRuntime() === "docker";
  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "preview-gate.mjs")], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...previewBaseEnv(),
      PORT: String(port),
      APP_PORT: String(appPort),
      PREVIEW_SLEEP_MS: String(getConfig().sleepMs),
      PREVIEW_APP_SCRIPT: path.join(process.cwd(), "scripts", "preview-server.mjs"),
      PREVIEW_REPOSITORY: input.repository,
      PREVIEW_PR: String(input.prNumber),
      PREVIEW_SHA: input.sha,
      PREVIEW_BRANCH: input.branch,
      PREVIEW_ENV_ID: input.envId,
      PREVIEW_RUNTIME: docker ? "docker" : "process",
      PREVIEW_IMAGE: image,
      PREVIEW_CONTAINER: `mayfly-app-${appPort}`,
    },
  });
  child.stderr?.on("data", (chunk) => console.error(String(chunk).trim()));
  child.unref();
  if (!child.pid) throw new Error("Preview process did not start.");
  return child.pid;
}

async function waitUntilListening(url: string) {
  const deadline = Date.now() + (previewRuntime() === "docker" ? 25_000 : 8_000);
  let last = "Preview process did not accept connections.";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `Preview process returned ${response.status}.`;
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(last);
}

async function remember(record: DeploymentRecord) {
  const file = await loadDeployments();
  file.deployments = file.deployments.filter((item) => item.deploymentId !== record.deploymentId);
  file.deployments.push(record);
  await writeJson(deployFile(), file);
}

async function launch(input: DeployRequest, previous: DeploymentRecord | undefined, image: string): Promise<Deployment> {
  const deploymentId = previous?.deploymentId || input.deploymentId || deploymentIdFor(input.envId);
  const docker = previewRuntime() === "docker";
  if (previous?.pid && gateAlive(previous.pid)) await killProcess(previous.pid);
  if (docker && previous?.port) await removeContainer(previous.port + 1000);
  // A new commit swaps the container; drop the old image only if no other deployment still uses it.
  const old = builtImage(previous?.image);
  if (docker && old && old !== image) {
    const file = await loadDeployments();
    if (!imageUsedElsewhere(file.deployments, old, deploymentId)) await removeImage(old);
  }
  const port = await claimPort(previous?.port);
  const pid = startPreview(port, input, image);
  const listenUrl = previewListenUrl(port);
  const url = publicPreviewUrl(input.repository, input.prNumber);
  try {
    await waitUntilListening(listenUrl);
  } catch (error) {
    await killProcess(pid);
    if (docker) {
      await removeContainer(port + 1000);
      const built = builtImage(image);
      if (built && image !== old) {
        const file = await loadDeployments();
        if (!imageUsedElsewhere(file.deployments, built, deploymentId)) await removeImage(built);
      }
    }
    throw error;
  }
  const now = new Date().toISOString();
  await remember({
    deploymentId,
    repository: input.repository,
    prNumber: input.prNumber,
    sha: input.sha,
    branch: input.branch,
    url,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    pid,
    port,
    image: docker ? builtImage(image) : undefined,
  });
  return { deploymentId, url };
}

/** Stop the gate, remove its container and image, and forget the record. The caller holds the lock. */
async function removeDeployment(deploymentId: string) {
  const file = await loadDeployments();
  const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
  if (existing?.pid && gateAlive(existing.pid)) await killProcess(existing.pid);
  if (previewRuntime() === "docker" && existing?.port) await removeContainer(existing.port + 1000);
  const image = builtImage(existing?.image);
  // Shared by tag across previews for the same PR+commit — only remove when nothing else still uses it.
  if (image && !imageUsedElsewhere(file.deployments, image, deploymentId)) await removeImage(image);
  file.deployments = file.deployments.filter((item) => item.deploymentId !== deploymentId);
  await writeJson(deployFile(), file);
}

/** Build or find the image; if that fails, nothing of an earlier version is left running. */
async function prepareOrTearDown(input: DeployRequest, deploymentId: string) {
  try {
    return await prepareImage(input);
  } catch (error) {
    await exclusive(() => removeDeployment(deploymentId)).catch(() => {});
    throw error;
  }
}

const processDeployer: Deployer = {
  async provision(input) {
    const deploymentId = deploymentIdFor(input.envId);
    const image = await prepareOrTearDown(input, deploymentId);
    return exclusive(async () => {
      const file = await loadDeployments();
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      if (existing?.pid && existing.sha === input.sha && gateAlive(existing.pid)) {
        return { deploymentId: existing.deploymentId, url: existing.url };
      }
      return launch(input, existing ? { ...existing, deploymentId } : ({ deploymentId } as DeploymentRecord), image);
    });
  },

  async update(input) {
    const deploymentId = input.deploymentId || deploymentIdFor(input.envId);
    const image = await prepareOrTearDown(input, deploymentId);
    return exclusive(async () => {
      const file = await loadDeployments();
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      return launch(input, existing ?? ({ deploymentId } as DeploymentRecord), image);
    });
  },

  async revive(input) {
    const deploymentId = input.deploymentId || deploymentIdFor(input.envId);
    const running = async () => {
      const file = await loadDeployments();
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      return existing?.pid && gateAlive(existing.pid) ? existing : undefined;
    };
    const alive = await exclusive(running);
    if (alive) return { deploymentId: alive.deploymentId, url: alive.url };
    // Restarting uses the image that is already built. It is built again only if it was removed.
    const image = await prepareImage(input);
    return exclusive(async () => {
      const again = await running();
      if (again) return { deploymentId: again.deploymentId, url: again.url };
      const file = await loadDeployments();
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      return launch(input, existing ?? ({ deploymentId } as DeploymentRecord), image);
    });
  },

  async destroy(input) {
    await exclusive(() => removeDeployment(input.deploymentId));
  },

  async list() {
    return exclusive(async () => {
      const file = await loadDeployments();
      const live: DeploymentRecord[] = [];
      for (const item of file.deployments) {
        if (item.pid && !gateAlive(item.pid)) continue;
        live.push(item);
      }
      if (live.length !== file.deployments.length) {
        file.deployments = live;
        await writeJson(deployFile(), file);
      }
      return live;
    });
  },
};

export function getDeployer(): Deployer {
  return getConfig().deployer === "fake" ? fakeDeployer : processDeployer;
}
