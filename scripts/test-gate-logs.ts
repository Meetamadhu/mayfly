/**
 * The preview gate keeps what the app printed, hides the repository's preview variables in it, and serves it on
 * GET /__preview_logs. This starts the real gate with a stand-in `docker` (a copy of Node that acts like the
 * commands the gate runs), so it needs no Docker. Run with: npx tsx scripts/test-gate-logs.ts
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "hunter2-very-secret-value";

const FAKE_DOCKER = String.raw`
const path = require("node:path");
if (!/^docker(\.exe)?$/i.test(path.basename(process.execPath))) return;
const fs = require("node:fs");
const http = require("node:http");
const verb = path.basename(process.argv[1] || "");
const args = process.argv.slice(2);
const pidFile = path.join(process.cwd(), "app.pid");
if (verb === "run") {
  const port = Number(args[args.indexOf("-p") + 1].split(":")[1]);
  fs.writeFileSync(pidFile, String(process.pid));
  const server = http.createServer((req, res) => {
    if (req.url === "/die") process.exit(3);
    res.end("hello from the app");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log("server listening on 3000");
    console.log("connecting with key " + process.env.API_KEY);
    console.error("warning: the cache is cold");
    process.stdout.write("a line with no newline yet");
  });
} else if (verb === "stop") {
  try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))); } catch {}
  process.exit(0);
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(what: string, read: () => Promise<T | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  const { readGateLog } = await import("../src/lib/gate-logs");
  const dir = mkdtempSync(path.join(tmpdir(), "mayfly-gate-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const dockerName = process.platform === "win32" ? "docker.exe" : "docker";
  copyFileSync(process.execPath, path.join(bin, dockerName));
  writeFileSync(path.join(dir, "fake-docker.cjs"), FAKE_DOCKER);
  // The gate runs `docker run`, `docker rm`, `docker stop`: Node treats that first word as a script in the working directory.
  for (const verb of ["run", "rm", "stop"]) writeFileSync(path.join(dir, verb), "");

  const gatePort = await freePort();
  const appPort = await freePort();
  const output: string[] = [];
  let gate: ChildProcess | null = null;
  let passed = 0;
  const check = (name: string) => {
    passed += 1;
    console.log(`ok - ${name}`);
  };

  try {
    gate = spawn(process.execPath, [path.join(here, "preview-gate.mjs")], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_OPTIONS: `--require=${path.join(dir, "fake-docker.cjs")}`,
        PORT: String(gatePort),
        APP_PORT: String(appPort),
        PREVIEW_RUNTIME: "docker",
        PREVIEW_IMAGE: "someone/else:1",
        PREVIEW_CONTAINER: "mayfly-gate-test",
        PREVIEW_SLEEP_MS: "600000",
        MAYFLY_APP_ENV_API_KEY: SECRET,
        MAYFLY_APP_ENV_SHORT: "ab",
      },
    });
    for (const stream of [gate.stdout, gate.stderr]) stream?.on("data", (chunk) => output.push(String(chunk)));

    const base = `http://127.0.0.1:${gatePort}`;
    const logs = async () => {
      const response = await fetch(`${base}/__preview_logs`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      return (await response.json()) as { state: string; lines: string[] };
    };

    await waitFor("the gate to listen", async () => (await fetch(`${base}/__preview_status`)).ok);

    const before = await logs();
    assert.deepEqual(before, { state: "asleep", lines: [] });
    check("a gate that hasn't started the app has nothing to show, and asking doesn't start it");
    assert.equal((await (await fetch(`${base}/__preview_status`)).json()).state, "asleep");

    const page = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    assert.equal(await page.text(), "hello from the app");
    check("a visit starts the app and gets its page");

    const awake = await waitFor("the app's output", async () => {
      const snapshot = await logs();
      return snapshot.lines.some((line) => line.includes("cache is cold")) ? snapshot : null;
    });
    assert.equal(awake.state, "awake");
    assert.match(awake.lines[0], /^--- starting \d{4}-\d\d-\d\dT[\d:.]+Z ---$/);
    assert.ok(awake.lines.includes("server listening on 3000"));
    assert.ok(awake.lines.includes("warning: the cache is cold"), "stderr is kept too");
    check("what the app printed, on stdout and stderr, is kept in order after a starting marker");

    assert.ok(awake.lines.includes("connecting with key [hidden]"));
    assert.ok(!JSON.stringify(awake).includes(SECRET));
    check("a preview variable's value is hidden in the log");

    const asleepLog = await (async () => {
      await fetch(`${base}/__preview_sleep`, { method: "POST" });
      return waitFor("the sleep marker", async () => {
        const snapshot = await logs();
        return snapshot.lines.some((line) => line.includes("went to sleep")) ? snapshot : null;
      });
    })();
    assert.equal(asleepLog.state, "asleep");
    assert.ok(asleepLog.lines.includes("a line with no newline yet"), "a last line without a newline is not lost");
    assert.ok(asleepLog.lines.indexOf("a line with no newline yet") < asleepLog.lines.indexOf("--- the app went to sleep ---"));
    assert.ok(!asleepLog.lines.some((line) => /stopped with exit code/.test(line)), "sleeping isn't reported as a crash");
    check("sleep is marked as sleep, the unfinished last line is kept, and the log survives");

    const back = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    assert.equal(await back.text(), "hello from the app");
    const woke = await logs();
    assert.equal(woke.lines.filter((line) => line.startsWith("--- starting")).length, 2);
    assert.ok(woke.lines.includes("--- the app went to sleep ---"), "the earlier run is still there");
    check("waking again adds a second run to the same log");

    await fetch(`${base}/die`, { headers: { accept: "application/json" } }).catch(() => undefined);
    const crashed = await waitFor("the crash marker", async () => {
      const snapshot = await logs();
      return snapshot.lines.some((line) => line.includes("stopped with exit code 3")) ? snapshot : null;
    });
    assert.ok(crashed.lines.includes("--- the app stopped with exit code 3 ---"));
    check("an app that exits by itself is marked with its exit code");

    assert.ok(!output.join("").includes(SECRET), "the gate's own console never shows a preview variable");
    check("the gate's console output never shows a preview variable");

    const viaLibrary = await readGateLog(gatePort);
    assert.equal(viaLibrary?.state, "asleep");
    assert.ok(viaLibrary?.lines.includes("connecting with key [hidden]"));
    assert.equal(await readGateLog(await freePort()), null);
    check("Mayfly's reader gets the same lines, and gets null when no gate answers");
  } finally {
    gate?.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp folder isn't worth failing the test.
    }
  }
  console.log(`\n${passed} checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
