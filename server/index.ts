import express, { type NextFunction, type Request, type Response } from "express";
import { adminRouter } from "./routes/admin";
import { environmentsRouter } from "./routes/environments";
import { eventsRouter } from "./routes/events";
import { previewRouter } from "./routes/preview";
import { webhooksRouter } from "./routes/webhooks";
import { sendJson } from "./lib/respond";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const dev = process.argv.includes("--dev");

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

  // API + preview proxy live on Express. Mount before the Next.js catch-all.
  server.use(adminRouter);
  server.use(environmentsRouter);
  server.use(webhooksRouter);
  server.use(eventsRouter);
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

  await new Promise<void>((resolve, reject) => {
    const httpServer = server.listen(port, host, () => resolve());
    httpServer.on("error", reject);
  });

  console.log(`Mayfly ready on http://${host}:${port} (${dev ? "dev" : "production"})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
