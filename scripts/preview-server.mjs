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
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/IBMPlexSans-Regular.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/IBMPlexSans-Medium.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/IBMPlexSans-SemiBold.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/IBMPlexSans-Bold.woff2") format("woff2"); }
      :root {
        color-scheme: light;
        --bg: #efece4; --surface: #f7f5ef; --ink: #1c1915; --muted: #6f685e; --line: #ddd6c8; --soft: #e7e1d4;
        --on-ink: #f7f5ef; --accent: #ef6b42; --band-awake: #1f5c4a; --radius: 6px; --radius-lg: 14px; --btn-height: 44px;
      }
      html[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0f1c19; --surface: #17302b; --ink: #e8f0ea; --muted: #9bb0a8; --line: #2a4540; --soft: #2a4a42;
        --on-ink: #0f1c19; --accent: #ef6b42; --band-awake: #1f5c4a;
      }
      @media (prefers-color-scheme: dark) {
        html:not([data-theme="light"]) {
          --bg: #0f1c19; --surface: #17302b; --ink: #e8f0ea; --muted: #9bb0a8; --line: #2a4540; --soft: #2a4a42;
          --on-ink: #0f1c19; --accent: #ef6b42; --band-awake: #1f5c4a;
        }
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
      .card { width: min(36rem, 100%); overflow: hidden; border: 2px solid var(--band-awake); border-radius: var(--radius-lg); background: var(--surface); }
      .band { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.9rem 1.1rem; background: var(--band-awake); color: #fff; }
      .band svg { flex: none; margin-top: 0.1rem; }
      .word { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
      .note { margin: 0.2rem 0 0; font-size: 0.95rem; }
      .note.sub { font-size: 0.85rem; opacity: 0.85; }
      .body { padding: 1.15rem 1.15rem 1.25rem; }
      h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      h1 span { color: var(--muted); font-weight: 500; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.75rem 0 0; }
      .chip { border-radius: 999px; background: var(--soft); padding: 0.2rem 0.55rem; color: var(--ink); font-size: 0.84rem; }
      .mono { font-family: ui-monospace, monospace; }
      .back {
        display: inline-flex; align-items: center; justify-content: center; min-height: var(--btn-height);
        margin-top: 1rem; padding: 0.5rem 0.85rem; border: 1px solid var(--ink); border-radius: var(--radius);
        background: var(--ink); color: var(--on-ink); font-weight: 600; text-decoration: none;
      }
    </style>
    <script>
      (function () {
        var theme = null;
        try {
          var q = new URLSearchParams(location.search).get("mayfly_theme");
          if (q === "light" || q === "dark") theme = q;
        } catch (e) {}
        if (!theme) {
          try {
            var stored = localStorage.getItem("mayfly-theme");
            if (stored === "light" || stored === "dark") theme = stored;
          } catch (e) {}
        }
        if (!theme) {
          try {
            theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          } catch (e) {
            theme = "light";
          }
        }
        document.documentElement.dataset.theme = theme;
      })();
    </script>
  </head>
  <body>
    <a class="mayfly-strip" href="/">
      <svg class="mayfly-mark" viewBox="0 0 40 36" aria-hidden="true">
        <path d="M19 30V13M20 18C-1 13 1-5 16 9l4 9C41-3 43 12 21 20M20 20C1 15 6 31 18 25M22 20c19-8 13 12 0 5M17 7l-3-5m8 5 4-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
      </svg>
      Mayfly
    </a>
    <main class="card">
      <header class="band">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <div>
          <p class="word">Awake</p>
          <p class="note">This preview is awake.</p>
          <p class="note sub">This is Mayfly's demo app. Real pull requests show their own app here.</p>
        </div>
      </header>
      <div class="body">
        <h1>${escapeHtml(repository)}<span>#${escapeHtml(pr)}</span></h1>
        <p class="chips">
          <span class="chip">${escapeHtml(branch)}</span>
          <span class="chip mono">${escapeHtml(sha)}</span>
        </p>
        <a class="back" id="back" href="/board">Back to board</a>
        <script>(function(){var a=document.getElementById("back");try{var fromAdmin=false;var r=document.referrer?new URL(document.referrer):null;if(r&&r.host===location.host&&r.pathname.indexOf("/admin")===0)fromAdmin=true;if(new URLSearchParams(location.search).get("mayfly_from")==="admin")fromAdmin=true;if(fromAdmin){a.href="/admin";a.textContent="Back to admin";}}catch(e){}})();</script>
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
const host = process.env.HOST || "127.0.0.1";
setTimeout(() => server.listen(port, host), bootDelayMs);

// Linux: if the gate is killed without a chance to clean up, this process is re-parented. Exit instead of leaking.
if (process.platform !== "win32") {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000).unref();
}
