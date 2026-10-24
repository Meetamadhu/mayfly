import path from "node:path";
import { getConfig } from "./config";
import { createExclusive, readJson, writeJson } from "./store";
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
  return path.join(process.cwd(), "data", "deployments.json");
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

export function getDeployer(): Deployer {
  return fakeDeployer;
}
