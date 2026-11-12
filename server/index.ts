import express from "express";

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
  // Forward every request to Next.js. Route logic stays in the App Router.
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
