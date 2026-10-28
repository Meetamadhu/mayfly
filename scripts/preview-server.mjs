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

server.listen(port, "127.0.0.1");
