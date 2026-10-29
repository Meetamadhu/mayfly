import { createServer } from "node:http";

const port = Number(process.env.PORT);
const repository = process.env.PREVIEW_REPOSITORY ?? "";
const pr = process.env.PREVIEW_PR ?? "";
const sha = process.env.PREVIEW_SHA ?? "";
const branch = process.env.PREVIEW_BRANCH ?? "";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(repository)}#${escapeHtml(pr)}</title>
  </head>
  <body>
    <main>
      <p>Pull request preview</p>
      <h1>${escapeHtml(repository)}#${escapeHtml(pr)}</h1>
      <p>${escapeHtml(branch)}</p>
      <p>${escapeHtml(sha)}</p>
      <p>This preview is awake.</p>
    </main>
  </body>
</html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
});

// Simulated start time for demos; not a real cold start.
const bootDelayMs = Math.max(0, Number(process.env.PREVIEW_BOOT_DELAY_MS) || 0);
setTimeout(() => server.listen(port, "127.0.0.1"), bootDelayMs);

// Linux: if the gate is killed without a chance to clean up, this process is re-parented. Exit instead of leaking.
if (process.platform !== "win32") {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000).unref();
}
