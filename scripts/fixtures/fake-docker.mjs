#!/usr/bin/env node
/**
 * A stand-in for the docker command, for scripts/test-preview-settings.mjs. It writes each call (its arguments,
 * and which variables its own environment had) to PREVIEW_FAKE_DOCKER_LOG (PREVIEW_ so it reaches the gate) as one JSON line. "docker run" starts a tiny web
 * server on the published port that answers with the values of the variables passed with -e NAME, the way a real
 * container would see them. Every other command succeeds and does nothing.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const log = process.env.PREVIEW_FAKE_DOCKER_LOG;
const watched = (process.env.PREVIEW_FAKE_DOCKER_WATCH ?? "").split(",").filter(Boolean);
if (log) {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("MAYFLY_APP_ENV_") || watched.includes(name)) env[name] = process.env[name];
  }
  appendFileSync(log, `${JSON.stringify({ args, env })}\n`);
}

if (args[0] === "run") {
  const publish = args[args.indexOf("-p") + 1] ?? "";
  const port = Number(publish.split(":")[1]);
  const names = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-e" && !args[i + 1].includes("=")) names.push(args[i + 1]);
  }
  const seen = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(seen));
  });
  server.listen(port, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else if (args[0] === "build" && log) {
  // Remember the image, so "image inspect" finds it from now on.
  appendFileSync(`${log}.images`, `${args[args.indexOf("-t") + 1]}\n`);
} else if (args[0] === "image" && args[1] === "inspect") {
  const tag = args.at(-1);
  let built = [];
  try {
    built = readFileSync(`${log}.images`, "utf8").split("\n");
  } catch {}
  if (tag.startsWith("mayfly-pr-") && !built.includes(tag)) {
    process.stderr.write(`Error: No such image: ${tag}\n`);
    process.exit(1);
  }
  process.stdout.write(args.includes("{{.Size}}") ? "1000\n" : "sha256:fake\n");
} else if (args[0] === "info" || args[0] === "version") {
  process.stdout.write("{}\n");
}
