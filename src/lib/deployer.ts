import { execFile, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { getConfig } from "./config";
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

function killProcess(pid: number) {
  return new Promise<void>((resolve) => {
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

function startPreview(port: number, input: DeployRequest) {
  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "preview-gate.mjs")], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      APP_PORT: String(port + 1000),
      PREVIEW_SLEEP_MS: String(getConfig().sleepMs),
      PREVIEW_APP_SCRIPT: path.join(process.cwd(), "scripts", "preview-server.mjs"),
      PREVIEW_REPOSITORY: input.repository,
      PREVIEW_PR: String(input.prNumber),
      PREVIEW_SHA: input.sha,
      PREVIEW_BRANCH: input.branch,
    },
  });
  child.unref();
  if (!child.pid) throw new Error("Preview process did not start.");
  return child.pid;
}

async function waitUntilListening(url: string) {
  const deadline = Date.now() + 8_000;
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

async function launch(input: DeployRequest, previous?: DeploymentRecord): Promise<Deployment> {
  const deploymentId = previous?.deploymentId || input.deploymentId || deploymentIdFor(input.envId);
  if (previous?.pid && processAlive(previous.pid)) await killProcess(previous.pid);
  const port = await claimPort(previous?.port);
  const pid = startPreview(port, input);
  const url = previewListenUrl(port);
  try {
    await waitUntilListening(url);
  } catch (error) {
    await killProcess(pid);
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
  });
  return { deploymentId, url };
}

const processDeployer: Deployer = {
  async provision(input) {
    return exclusive(async () => {
      const file = await loadDeployments();
      const deploymentId = deploymentIdFor(input.envId);
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      if (existing?.pid && existing.sha === input.sha && processAlive(existing.pid)) {
        return { deploymentId: existing.deploymentId, url: existing.url };
      }
      return launch(input, existing ? { ...existing, deploymentId } : { deploymentId } as DeploymentRecord);
    });
  },

  async update(input) {
    return exclusive(async () => {
      const file = await loadDeployments();
      const deploymentId = input.deploymentId || deploymentIdFor(input.envId);
      const existing = file.deployments.find((item) => item.deploymentId === deploymentId);
      return launch(input, existing ?? ({ deploymentId } as DeploymentRecord));
    });
  },

  async destroy(input) {
    await exclusive(async () => {
      const file = await loadDeployments();
      const existing = file.deployments.find((item) => item.deploymentId === input.deploymentId);
      if (existing?.pid && processAlive(existing.pid)) await killProcess(existing.pid);
      file.deployments = file.deployments.filter((item) => item.deploymentId !== input.deploymentId);
      await writeJson(deployFile(), file);
    });
  },

  async list() {
    return exclusive(async () => {
      const file = await loadDeployments();
      const live: DeploymentRecord[] = [];
      for (const item of file.deployments) {
        if (item.pid && !processAlive(item.pid)) continue;
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
