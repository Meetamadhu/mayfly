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
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(repository)}#${escapeHtml(pr)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #efece4; color: #1c1915; font-family: "Segoe UI", system-ui, sans-serif; }
      .card { width: min(36rem, calc(100% - 2rem)); overflow: hidden; border: 1px solid #ddd6c8; border-radius: 14px; background: #f7f5ef; }
      .band { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.9rem 1.1rem; background: #6b4200; color: #fff; }
      .band svg { flex: none; margin-top: 0.1rem; }
      .word { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; }
      .note { margin: 0.2rem 0 0; font-size: 0.95rem; }
      .body { padding: 1.15rem 1.15rem 1.25rem; }
      h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      h1 span { color: #6f685e; font-weight: 500; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.75rem 0 0; }
      .chip { border-radius: 999px; background: #e7e1d4; padding: 0.2rem 0.55rem; color: #1c1915; font-size: 0.84rem; }
      .mono { font-family: ui-monospace, monospace; }
      .back { display: inline-flex; align-items: center; min-height: 44px; margin-top: 1rem; padding: 0 0.9rem; border-radius: 6px; background: #1c1915; color: #f7f5ef; font-weight: 600; text-decoration: none; }
      html[data-theme="dark"] body { background: #141311; color: #f6f3ec; }
      html[data-theme="dark"] .card { background: #221f1a; border-color: #3d362e; }
      html[data-theme="dark"] h1 span { color: #c9c0b4; }
      html[data-theme="dark"] .chip { background: #2c2822; color: #f6f3ec; }
      html[data-theme="dark"] a.back { background: #f6f3ec; color: #141311; }
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
    <main class="card">
      <header class="band">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <div>
          <p class="word">AWAKE</p>
          <p class="note">This preview is awake.</p>
        </div>
      </header>
      <div class="body">
        <h1>${escapeHtml(repository)}<span>#${escapeHtml(pr)}</span></h1>
        <p class="chips">
          <span class="chip">${escapeHtml(branch)}</span>
          <span class="chip mono">${escapeHtml(sha)}</span>
        </p>
        <a class="back" href="/">Back</a>
      </div>
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
