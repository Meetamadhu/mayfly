import { execFile } from "node:child_process";
import { childEnv } from "./builder";

const LOOKUP_LIMIT_MS = 15_000;

/** The commit a pull request points at on GitHub right now, or null if it cannot be found. */
export function pullRequestHead(repository: string, prNumber: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", `https://github.com/${repository}.git`, `refs/pull/${prNumber}/head`],
      { timeout: LOOKUP_LIMIT_MS, windowsHide: true, env: childEnv() },
      (error, stdout) => {
        if (error) return resolve(null);
        const sha = String(stdout).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        resolve(/^[0-9a-f]{40}$/.test(sha) ? sha : null);
      },
    );
  });
}
