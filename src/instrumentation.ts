import { execFileSync } from "node:child_process";

function removePreviewContainers() {
  const stdout = execFileSync("docker", ["ps", "-q", "--filter", "label=mayfly.preview=1"], {
    timeout: 2000,
    encoding: "utf8",
    windowsHide: true,
  });
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  execFileSync("docker", ["rm", "-f", ...ids], { timeout: 2500, windowsHide: true });
}

function listenForShutdown() {
  const marker = globalThis as unknown as { __mayflyShutdown?: boolean };
  if (marker.__mayflyShutdown) return;
  marker.__mayflyShutdown = true;
  const shutdown = () => {
    if (process.env.PREVIEW_RUNTIME === "docker") {
      try {
        removePreviewContainers();
      } catch (error) {
        console.error("Could not remove preview containers", error instanceof Error ? error.message : error);
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  listenForShutdown();
  const { removeOrphanPreviewContainers, restorePreviews } = await import("./lib/lifecycle");
  const { startReaperLoop } = await import("./lib/reaper-loop");
  await removeOrphanPreviewContainers();
  await restorePreviews();
  startReaperLoop();
}
