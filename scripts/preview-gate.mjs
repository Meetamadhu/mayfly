import { execFile, spawn } from "node:child_process";
import { createServer, request as forward } from "node:http";

const port = Number(process.env.PORT);
const appPort = Number(process.env.APP_PORT);
const idleMs = Number(process.env.PREVIEW_SLEEP_MS || 20_000);
const script = process.env.PREVIEW_APP_SCRIPT;
const useDocker = process.env.PREVIEW_RUNTIME === "docker";
const containerName = process.env.PREVIEW_CONTAINER || `mayfly-app-${appPort}`;
const image = process.env.PREVIEW_IMAGE || "mayfly-preview:local";
const envId = process.env.PREVIEW_ENV_ID || "";

const DEFAULT_MEMORY = "256m";
const DEFAULT_CPUS = "0.5";

/** 128m to 2g, in m or g. Anything else falls back to the default. */
function containerMemory(value) {
  const match = /^(\d+)([mg])$/.exec((value ?? "").trim().toLowerCase());
  if (!match) return DEFAULT_MEMORY;
  const megabytes = Number(match[1]) * (match[2] === "g" ? 1024 : 1);
  return megabytes >= 128 && megabytes <= 2048 ? `${match[1]}${match[2]}` : DEFAULT_MEMORY;
}

/** 0.1 to 4 CPUs. Anything else falls back to the default. */
function containerCpus(value) {
  const text = (value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return DEFAULT_CPUS;
  const cpus = Number(text);
  return cpus >= 0.1 && cpus <= 4 ? String(cpus) : DEFAULT_CPUS;
}

const memory = containerMemory(process.env.PREVIEW_MEMORY);
const cpus = containerCpus(process.env.PREVIEW_CPUS);

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

function dockerExec(args) {
  return new Promise((resolve) => {
    execFile("docker", args, { windowsHide: true }, () => resolve());
  });
}

function stopApp() {
  listening = false;
  if (useDocker) {
    const pid = child?.pid;
    child = null;
    stopping = dockerExec(["stop", "-t", "1", containerName]).then(() => {
      if (!pid || process.platform !== "win32") return;
      return new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    });
    return;
  }
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
      probe.on("timeout", () => probe.destroy());
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
      if (!useDocker && !script) throw new Error("PREVIEW_APP_SCRIPT is not set");
      if (useDocker) await dockerExec(["rm", "-f", containerName]);
      const spawned = useDocker
        ? spawn(
            "docker",
            [
              "run",
              "--rm",
              "--name",
              containerName,
              "--label",
              "mayfly.preview=1",
              "--label",
              `mayfly.env=${envId}`,
              "--memory",
              memory,
              "--memory-swap",
              memory,
              "--cpus",
              cpus,
              "--pids-limit",
              "100",
              "--user",
              "1000:1000",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--read-only",
              "--tmpfs",
              "/tmp:rw,size=16m",
              "-p",
              `127.0.0.1:${appPort}:3000`,
              "-e",
              "PORT=3000",
              "-e",
              "HOST=0.0.0.0",
              "-e",
              `PREVIEW_REPOSITORY=${process.env.PREVIEW_REPOSITORY ?? ""}`,
              "-e",
              `PREVIEW_PR=${process.env.PREVIEW_PR ?? ""}`,
              "-e",
              `PREVIEW_SHA=${process.env.PREVIEW_SHA ?? ""}`,
              "-e",
              `PREVIEW_BRANCH=${process.env.PREVIEW_BRANCH ?? ""}`,
              image,
            ],
            { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn(process.execPath, [script], {
            // Own process group on Linux so stopApp can kill the whole app tree without killing the gate.
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: "ignore",
            env: { ...appEnv(), PORT: String(appPort) },
          });
      child = spawned;
      let dockerLog = "";
      if (useDocker) {
        spawned.stdout?.on("data", (chunk) => {
          dockerLog += chunk.toString();
        });
        spawned.stderr?.on("data", (chunk) => {
          dockerLog += chunk.toString();
        });
      }
      spawned.on("exit", (code) => {
        if (useDocker && code) console.error(dockerLog.trim());
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

/** Drop headers a preview app must not use to influence Mayfly's proxy policy. */
function appResponseHeaders(incoming) {
  const headers = { ...incoming.headers };
  delete headers["x-mayfly-page"];
  return headers;
}

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
      // Never forward x-mayfly-page from the app — only this gate may mark Mayfly pages.
      res.writeHead(response.statusCode || 502, appResponseHeaders(response));
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

// Self-contained HTML/CSS/JS. Fonts load from Mayfly at /fonts (same origin when opened via /p/...).
const wakePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Waking up this preview</title>
    <style>
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/IBMPlexSans-Regular.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/IBMPlexSans-Medium.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/IBMPlexSans-SemiBold.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/IBMPlexSans-Bold.woff2") format("woff2"); }
      :root {
        color-scheme: light;
        --bg: #efece4; --surface: #f7f5ef; --ink: #1c1915; --muted: #6f685e; --line: #ddd6c8; --soft: #e7e1d4;
        --on-ink: #f7f5ef; --accent: #ef6b42; --band-work: #8a5a12; --band-failed: #8d2e2e;
        --radius: 6px; --radius-lg: 14px; --btn-height: 44px;
      }
      html[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0f1c19; --surface: #17302b; --ink: #e8f0ea; --muted: #9bb0a8; --line: #2a4540; --soft: #1f3a34;
        --on-ink: #0f1c19; --accent: #ef6b42; --band-work: #8a5a12; --band-failed: #8d2e2e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: grid; justify-items: center; align-content: start; gap: 1rem;
        padding: 1.25rem 1rem 2rem; background: var(--bg); color: var(--ink);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif; font-size: 16px; line-height: 1.45;
      }
      .mayfly-strip {
        width: min(36rem, 100%); display: inline-flex; align-items: center; gap: 0.5rem;
        padding: 0.65rem 0.9rem; border: 1px solid var(--line); border-radius: var(--radius-lg);
        background: var(--surface); color: var(--ink); text-decoration: none; font-weight: 700; letter-spacing: -0.03em;
      }
      .mayfly-mark { width: 1.35rem; height: 1.2rem; color: var(--accent); flex: none; }
      .card { width: min(36rem, 100%); overflow: hidden; border: 2px solid var(--band-work); border-radius: var(--radius-lg); background: var(--surface); }
      .card[data-failed="true"] { border-color: var(--band-failed); }
      .band { padding: 0.9rem 1.1rem; background: var(--band-work); color: #fff; }
      .band.failed { background: var(--band-failed); }
      .word { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
      h1 { margin: 0.2rem 0 0; font-size: 1.15rem; font-weight: 600; color: #fff; }
      .body { padding: 1.15rem 1.15rem 1.3rem; }
      .meta { margin: 0; color: var(--muted); }
      .sha { font-family: ui-monospace, monospace; }
      .spinner { width: 28px; height: 28px; margin: 1rem 0; border: 3px solid var(--line); border-top-color: var(--band-work); border-radius: 50%; animation: spin 0.9s linear infinite; }
      a { color: var(--ink); }
      a.back {
        display: inline-flex; align-items: center; justify-content: center; min-height: var(--btn-height);
        margin-top: 1rem; padding: 0.5rem 0.85rem; border: 1px solid var(--ink); border-radius: var(--radius);
        background: var(--ink); color: var(--on-ink); font-weight: 600; text-decoration: none;
      }
      [hidden] { display: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <script>
      try {
        var theme = localStorage.getItem("mayfly-theme");
        if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        document.documentElement.dataset.theme = theme;
      } catch (e) {}
    </script>
  </head>
  <body>
    <a class="mayfly-strip" href="/">
      <svg class="mayfly-mark" viewBox="0 0 40 36" aria-hidden="true">
        <path d="M19 30V13M20 18C-1 13 1-5 16 9l4 9C41-3 43 12 21 20M20 20C1 15 6 31 18 25M22 20c19-8 13 12 0 5M17 7l-3-5m8 5 4-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
      </svg>
      Mayfly
    </a>
    <main class="card" id="card">
      <div id="waking">
        <header class="band">
          <p class="word">Waking</p>
          <h1>Waking up this preview</h1>
        </header>
        <div class="body">
          <p class="meta">${wakeLabel} <span class="sha">${wakeSha}</span></p>
          <div class="spinner" aria-hidden="true"></div>
          <p class="meta" role="status"><span id="elapsed">0</span>s</p>
          <a class="back" id="back" href="/board">Back to board</a>
          <script>(function(){var a=document.getElementById("back");try{var r=document.referrer?new URL(document.referrer):null;if(r&&r.host===location.host&&r.pathname.indexOf("/admin")===0){a.href="/admin";a.textContent="Back to admin";}}catch(e){}})();</script>
        </div>
      </div>
      <div id="failed" hidden>
        <header class="band failed">
          <p class="word">Failed</p>
          <h1>Couldn't wake this preview</h1>
        </header>
        <div class="body">
          <p class="meta">${wakeLabel} <span class="sha">${wakeSha}</span></p>
          <p><a id="retry" href="">Retry</a></p>
          <a class="back" id="back" href="/board">Back to board</a>
          <script>(function(){var a=document.getElementById("back");try{var r=document.referrer?new URL(document.referrer):null;if(r&&r.host===location.host&&r.pathname.indexOf("/admin")===0){a.href="/admin";a.textContent="Back to admin";}}catch(e){}})();</script>
        </div>
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
            document.getElementById("card").setAttribute("data-failed", "true");
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
  // x-mayfly-page tells Mayfly's /p/ proxy to skip the preview sandbox so this page can poll and reload.
  if (req.method === "GET" && wantsHtml(req) && !(alive() && listening)) {
    boot().catch(() => {});
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-mayfly-page": "waking",
    });
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
    if (useDocker) {
      execFile("docker", ["stop", "-t", "1", containerName], { windowsHide: true }, () => process.exit(0));
      return;
    }
    if (child?.pid) killAppGroup(child.pid);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
