import { execFile, spawn } from "node:child_process";
import { createServer, request as forward } from "node:http";

const port = Number(process.env.PORT);
const appPort = Number(process.env.APP_PORT);
const idleMs = Number(process.env.PREVIEW_SLEEP_MS || 20_000);
const script = process.env.PREVIEW_APP_SCRIPT;

let child = null;
let lastActive = 0;
let booting = null;

function alive() {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function stopApp() {
  if (!child?.pid) {
    child = null;
    return;
  }
  const pid = child.pid;
  child = null;
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}

function waitForApp() {
  const deadline = Date.now() + 30_000;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const probe = forward(
        { hostname: "127.0.0.1", port: appPort, path: "/", method: "GET", timeout: 500 },
        (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 500) {
            resolve();
            return;
          }
          if (Date.now() > deadline) reject(new Error("Preview app did not wake."));
          else setTimeout(tick, 50);
        },
      );
      probe.on("error", () => {
        if (Date.now() > deadline) reject(new Error("Preview app did not wake."));
        else setTimeout(tick, 50);
      });
      probe.end();
    };
    tick();
  });
}

function boot() {
  if (alive()) return Promise.resolve();
  if (booting) return booting;
  booting = (async () => {
    try {
      const spawned = spawn(process.execPath, [script], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, PORT: String(appPort) },
      });
      child = spawned;
      spawned.on("exit", () => {
        if (child === spawned) child = null;
      });
      await waitForApp();
      lastActive = Date.now();
    } catch (error) {
      stopApp();
      throw error;
    } finally {
      booting = null;
    }
  })();
  return booting;
}

setInterval(() => {
  if (alive() && lastActive > 0 && Date.now() - lastActive >= idleMs) stopApp();
}, 500).unref();

function proxy(req, res) {
  const upstream = forward(
    {
      hostname: "127.0.0.1",
      port: appPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${appPort}` },
    },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Preview failed to wake.");
    }
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const pathOnly = (req.url || "/").split("?")[0];
  if (pathOnly === "/__preview_status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ state: alive() ? "awake" : "asleep", sleepSeconds: idleMs / 1000 }));
    return;
  }
  boot()
    .then(() => {
      lastActive = Date.now();
      proxy(req, res);
    })
    .catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("Preview failed to wake.");
      }
    });
});

server.listen(port, "127.0.0.1");
