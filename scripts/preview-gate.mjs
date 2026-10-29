import { execFile, spawn } from "node:child_process";
import { createServer, request as forward } from "node:http";

const port = Number(process.env.PORT);
const appPort = Number(process.env.APP_PORT);
const idleMs = Number(process.env.PREVIEW_SLEEP_MS || 20_000);
const script = process.env.PREVIEW_APP_SCRIPT;

let child = null;
let lastActive = 0;
let booting = null;
let listening = false;
let stopping = null;

function alive() {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

/**
 * Linux/macOS: the app is spawned detached, so it leads its own process group. Killing the negative pid
 * takes down the app and anything it started, and leaves this gate running.
 */
function killAppGroup(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      return;
    } catch {
      // no such group, or already gone: try the bare pid
    }
  }
}

function stopApp() {
  listening = false;
  if (!child?.pid) {
    child = null;
    return;
  }
  const pid = child.pid;
  child = null;
  if (process.platform !== "win32") {
    killAppGroup(pid);
    return;
  }
  // taskkill is asynchronous. A boot must wait for it, or waitForApp could see the dying old app.
  stopping = new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
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

// The app sees only PATH, NODE_ENV and PREVIEW_* (plus Windows system variables Node needs), never Mayfly's secrets.
// Mayfly already filters what this gate receives; filtering again here keeps the app safe if the gate is started some other way.
const PASS_THROUGH = ["PATH", "NODE_ENV"];
const WINDOWS_PASS_THROUGH = ["SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT"];

function appEnv() {
  const env = {};
  const names = process.platform === "win32" ? [...PASS_THROUGH, ...WINDOWS_PASS_THROUGH] : PASS_THROUGH;
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("PREVIEW_") && value !== undefined) env[name] = value;
  }
  return env;
}

function gateState() {
  if (booting) return "waking";
  if (alive() && listening) return "awake";
  return "asleep";
}

function boot() {
  if (booting) return booting;
  if (alive() && listening) return Promise.resolve();
  booting = (async () => {
    try {
      // Starting a boot counts as activity so the idle reaper cannot kill a slow-starting app.
      lastActive = Date.now();
      if (stopping) await stopping;
      const spawned = spawn(process.execPath, [script], {
        // Own process group on Linux so stopApp can kill the whole app tree without killing the gate.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: "ignore",
        env: { ...appEnv(), PORT: String(appPort) },
      });
      child = spawned;
      spawned.on("exit", () => {
        if (child === spawned) {
          child = null;
          listening = false;
        }
      });
      await waitForApp();
      listening = true;
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
  if (alive() && !booting && lastActive > 0 && Date.now() - lastActive >= idleMs) stopApp();
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const wakeLabel = `${escapeHtml(process.env.PREVIEW_REPOSITORY)}#${escapeHtml(process.env.PREVIEW_PR)}`;
const wakeSha = escapeHtml((process.env.PREVIEW_SHA || "").slice(0, 7));

// Self-contained: inline CSS and JS only, no external requests.
const wakePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Waking up this preview</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f6f6f4; color: #1d1d1b; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      .meta { color: #55554f; margin: 0.25rem 0; }
      .sha { font-family: ui-monospace, monospace; }
      .spinner { width: 28px; height: 28px; margin: 1.25rem auto; border: 3px solid #d4d4cf; border-top-color: #1d1d1b; border-radius: 50%; animation: spin 0.9s linear infinite; }
      a { color: inherit; }
      [hidden] { display: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div id="waking">
        <h1>Waking up this preview</h1>
        <p class="meta">${wakeLabel} <span class="sha">${wakeSha}</span></p>
        <div class="spinner" aria-hidden="true"></div>
        <p class="meta" role="status"><span id="elapsed">0</span>s</p>
      </div>
      <div id="failed" hidden>
        <h1>Couldn't wake this preview</h1>
        <p class="meta">${wakeLabel} <span class="sha">${wakeSha}</span></p>
        <p><a id="retry" href="">Retry</a></p>
      </div>
    </main>
    <script>
      (function () {
        var started = Date.now();
        var timer = null;
        function stop(failed) {
          clearInterval(timer);
          if (failed) {
            document.getElementById("waking").hidden = true;
            document.getElementById("failed").hidden = false;
            document.getElementById("retry").href = location.href;
          }
        }
        function tick() {
          var seconds = Math.floor((Date.now() - started) / 1000);
          document.getElementById("elapsed").textContent = String(seconds);
          if (seconds >= 45) return stop(true);
          fetch(location.href, { headers: { "X-Mayfly-Probe": "1" }, cache: "no-store" })
            .then(function (response) { return response.json(); })
            .then(function (body) {
              if (body && body.state === "awake") {
                stop(false);
                location.reload();
              }
            })
            .catch(function () {});
        }
        timer = setInterval(tick, 1000);
      })();
    </script>
  </body>
</html>`;

function wantsHtml(req) {
  return String(req.headers.accept || "").toLowerCase().includes("text/html");
}

const server = createServer((req, res) => {
  const pathOnly = (req.url || "/").split("?")[0];
  // Status must stay non-waking and must not count as activity.
  if (pathOnly === "/__preview_status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ state: gateState(), sleepSeconds: idleMs / 1000 }));
    return;
  }
  if (req.method === "POST" && pathOnly === "/__preview_sleep") {
    stopApp();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ state: "asleep" }));
    return;
  }
  // Probes report state only: they never boot and never count as activity.
  if (req.headers["x-mayfly-probe"] !== undefined) {
    const state = alive() && listening ? "awake" : booting ? "waking" : "asleep";
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ state }));
    return;
  }
  // Browser navigation to a sleeping preview: start the boot, answer immediately.
  if (req.method === "GET" && wantsHtml(req) && !(alive() && listening)) {
    boot().catch(() => {});
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(wakePage);
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

// The deployer sends SIGTERM to this gate's process group on destroy. The app lives in its own group,
// so take it down here; otherwise it would outlive the gate.
if (process.platform !== "win32") {
  const shutdown = () => {
    if (child?.pid) killAppGroup(child.pid);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
