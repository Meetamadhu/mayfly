import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminRouter } from "./routes/admin";
import { backupsRouter } from "./routes/backups";
import { wellKnownRouter } from "./routes/well-known";
import { environmentsRouter } from "./routes/environments";
import { eventsRouter } from "./routes/events";
import { feedbackRouter } from "./routes/feedback";
import { backRouter } from "./routes/back";
import { healthRouter } from "./routes/health";
import { opsRouter } from "./routes/ops";
import { policyRouter } from "./routes/policy";
import { previewRouter } from "./routes/preview";
import { previewsRouter } from "./routes/previews";
import { previewSettingsRouter } from "./routes/preview-settings";
import { costControlRouter } from "./routes/cost-control";
import { planRouter } from "./routes/plan";
import { billingRouter } from "./routes/billing";
import { previewAccessRouter } from "./routes/preview-access";
import { resourcesRouter } from "./routes/resources";
import { webhooksRouter } from "./routes/webhooks";
import { sendJson } from "./lib/respond";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const dev = process.argv.includes("--dev");

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

function listenForShutdown(httpServer: Server) {
  const marker = globalThis as unknown as { __mayflyShutdown?: boolean };
  if (marker.__mayflyShutdown) return;
  marker.__mayflyShutdown = true;

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (process.env.PREVIEW_RUNTIME === "docker") {
      try {
        removePreviewContainers();
      } catch (error) {
        console.error("Could not remove preview containers", error instanceof Error ? error.message : error);
      }
    }
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function startBackgroundWork() {
  // Skip a second run if tsx/HMR reloads this module in --dev.
  const marker = globalThis as unknown as { __mayflyBooted?: boolean };
  if (marker.__mayflyBooted) return;
  marker.__mayflyBooted = true;

  const { getConfig } = await import("@/lib/config");
  getConfig(); // Warns once about invalid PREVIEW_SLEEP_RULES entries.
  const { loadPolicy, removeOrphanPreviewContainers, restorePreviews } = await import("@/lib/lifecycle");
  const { startReaperLoop } = await import("@/lib/reaper-loop");
  // Restored previews start their gates with the saved sleep times, so load the policy first.
  await loadPolicy();
  await removeOrphanPreviewContainers();
  await restorePreviews();
  startReaperLoop();
  // A restart nobody asked for usually means a crash, so say when Mayfly comes up.
  const { sendAlert } = await import("@/lib/alerts");
  void sendAlert("started", "started up", [
    "Expected after an update or a server restart. Otherwise it may have crashed: check the server log.",
  ]);
}

async function main() {
  // Production must not depend on the host having set NODE_ENV.
  if (!dev) {
    (process.env as NodeJS.ProcessEnv & { NODE_ENV: string }).NODE_ENV = "production";
  }

  const { default: next } = await import("next");
  const app = next({ dev });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = express();
  server.disable("x-powered-by");
  // Behind a proxy on the same machine (deploy/aws sets TRUST_PROXY=loopback), read https from X-Forwarded-Proto
  // so preview apps are told the real protocol. Unset everywhere else, which keeps the old behaviour.
  if (process.env.TRUST_PROXY === "loopback") server.set("trust proxy", "loopback");

  // API + preview proxy live on Express. Mount before the Next.js catch-all.
  server.use(wellKnownRouter);
  server.use(healthRouter);
  server.use(opsRouter);
  server.use(adminRouter);
  server.use(backupsRouter);
  server.use(environmentsRouter);
  server.use(webhooksRouter);
  server.use(eventsRouter);
  server.use(previewsRouter);
  server.use(previewSettingsRouter);
  server.use(costControlRouter);
  server.use(planRouter);
  server.use(billingRouter);
  server.use(feedbackRouter);
  server.use(backRouter);
  server.use(policyRouter);
  server.use(resourcesRouter);
  server.use(previewAccessRouter);
  server.use(previewRouter);
  server.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === "object" && err !== null
        ? Number(
            "status" in err
              ? (err as { status?: unknown }).status
              : "statusCode" in err
                ? (err as { statusCode?: unknown }).statusCode
                : NaN,
          )
        : NaN;
    if (Number.isInteger(status) && status >= 400 && status <= 499) {
      const message =
        err instanceof Error && err.message.trim() ? err.message : "Request error.";
      sendJson(res, { ok: false, error: message }, status);
      return;
    }
    console.error(err);
    sendJson(res, { ok: false, code: "internal", error: "Internal error." }, 500);
  });

  // Pages stay in the App Router for now.
  server.use((req, res) => {
    void handle(req, res);
  });

  await startBackgroundWork();

  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listening = server.listen(port, host, () => resolve(listening));
    listening.on("error", reject);
  });

  listenForShutdown(httpServer);
  console.log(`Mayfly ready on http://${host}:${port} (${dev ? "dev" : "production"})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
