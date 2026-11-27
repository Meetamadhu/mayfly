/**
 * Which Mayfly this process is. Useful when you run more than one host: each keeps its own Docker daemon and a
 * disjoint PREVIEW_REPOS list, and the admin health page names the instance so you can tell them apart.
 *
 * True shared preview capacity across hosts (any host can run any preview) needs sticky routing and moving
 * containers; that isn't built. Sharding by repository is the supported way to scale out.
 */

export function instanceName(env: Record<string, string | undefined> = process.env) {
  const named = (env["MAYFLY_INSTANCE"] ?? "").trim().slice(0, 64);
  if (named) return named;
  if (env["RENDER_SERVICE_NAME"]) return String(env["RENDER_SERVICE_NAME"]).slice(0, 64);
  if (env["HOSTNAME"]) return String(env["HOSTNAME"]).slice(0, 64);
  return "mayfly";
}

/** Repositories this instance is willing to build, or null when it isn't building pull requests' own code. */
export function instanceRepos(env: Record<string, string | undefined> = process.env): string[] | null {
  if ((env["PREVIEW_RUNTIME"] ?? "process").trim().toLowerCase() !== "docker") return null;
  if (env["VERCEL"] || env["DEPLOYER"] === "fake") return null;
  const list = (env["PREVIEW_REPOS"] ?? "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((item) => /^[\w.-]+\/[\w.-]+$/.test(item));
  return list;
}
