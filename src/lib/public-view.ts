import type { DeploymentRecord, Environment, Overview } from "./types";

/**
 * What /api/environments shows to visitors who aren't signed in as admin. The board, Activity and Cost pages
 * only need lifecycle data, so the PR comment text, GitHub ids, PR labels, full build errors and local process
 * details (ports, pids, images) are left out. Signed-in admins get everything.
 */
export function publicEnvironment(env: Environment): Environment {
  const { githubCommentId: _comment, labels: _labels, ...rest } = env;
  const firstLine = env.error?.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    ...rest,
    comments: [],
    error: env.error ? (firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine || "Failed.") : null,
  };
}

function publicDeployment(record: DeploymentRecord): DeploymentRecord {
  const { pid: _pid, port: _port, image: _image, ...rest } = record;
  return rest;
}

export function publicOverview(overview: Overview): Overview {
  return {
    ...overview,
    environments: overview.environments.map(publicEnvironment),
    deployments: overview.deployments.map(publicDeployment),
  };
}
