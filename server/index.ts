import express from "express";
import next from "next";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

async function main() {
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

  console.log(`Mayfly ready on http://${host}:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
