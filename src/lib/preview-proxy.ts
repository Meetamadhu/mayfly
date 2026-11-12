import { request as forward, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Request, Response } from "express";
import { ADMIN_COOKIE } from "./admin";
import { findProxyTarget, recordActivity } from "./lifecycle";

// Never forwarded in either direction. host is rewritten, x-mayfly-admin is a Mayfly secret.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_ONLY_DROP = new Set(["host", "x-mayfly-admin"]);

/** Isolates preview document JS from Mayfly's origin (no allow-same-origin). */
const PREVIEW_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

const MAYFLY_PAGE_HEADER = "x-mayfly-page";

/** True when a Set-Cookie line would set or clear Mayfly's admin session cookie. */
function isAdminSetCookie(value: string) {
  const eq = value.indexOf("=");
  const name = (eq === -1 ? value : value.slice(0, eq)).trim();
  return name === ADMIN_COOKIE;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Prepare headers for the browser: drop forged Mayfly-page markers and admin cookie writes,
 * then sandbox real preview app responses (Mayfly's own waking page is exempt).
 * Mutates a plain Node header object in place — one copy for Express and (formerly) Next.
 */
export function finalizePreviewHeaders(headers: IncomingHttpHeaders) {
  const mayflyPage = headerValue(headers, MAYFLY_PAGE_HEADER);
  delete headers[MAYFLY_PAGE_HEADER];

  const rawCookies = headers["set-cookie"];
  if (rawCookies) {
    const setCookies = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    const kept = setCookies.filter((cookie) => !isAdminSetCookie(cookie));
    if (kept.length === 0) delete headers["set-cookie"];
    else headers["set-cookie"] = kept;
  }

  // Only the gate may set x-mayfly-page (it strips the header from the app). Skip sandbox for those pages.
  if (!mayflyPage) {
    const existing = headers["content-security-policy"];
    if (existing === undefined) {
      headers["content-security-policy"] = PREVIEW_SANDBOX_CSP;
    } else if (Array.isArray(existing)) {
      headers["content-security-policy"] = [...existing, PREVIEW_SANDBOX_CSP];
    } else {
      headers["content-security-policy"] = [existing, PREVIEW_SANDBOX_CSP];
    }
  }
}

// A page load fans out into many asset requests. One state write per environment per second is plenty.
const ACTIVITY_THROTTLE_MS = 1000;
const lastRecorded = globalThis as unknown as { __previewActivity?: Map<string, number> };

function sendText(res: Response, status: number, body: string) {
  res
    .status(status)
    .set({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
    .send(body);
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// What a person sees at a preview address that has no live preview. Matches board tokens / demo preview card.
const NOT_FOUND_STYLE = `
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/IBMPlexSans-Regular.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/IBMPlexSans-Medium.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/IBMPlexSans-SemiBold.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/IBMPlexSans-Bold.woff2") format("woff2"); }
      :root {
        color-scheme: light;
        --bg: #efece4; --surface: #f7f5ef; --ink: #1c1915; --muted: #6f685e; --line: #ddd6c8; --soft: #e7e1d4;
        --on-ink: #f7f5ef; --accent: #ef6b42; --dead: #5f594f; --radius: 6px; --radius-lg: 14px; --btn-height: 44px;
      }
      html[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0f1c19; --surface: #17302b; --ink: #e8f0ea; --muted: #9bb0a8; --line: #2a4540; --soft: #2a4a42;
        --on-ink: #0f1c19; --accent: #ef6b42; --dead: #b7c7c1;
      }
      @media (prefers-color-scheme: dark) {
        html:not([data-theme="light"]) {
          --bg: #0f1c19; --surface: #17302b; --ink: #e8f0ea; --muted: #9bb0a8; --line: #2a4540; --soft: #2a4a42;
          --on-ink: #0f1c19; --accent: #ef6b42; --dead: #b7c7c1;
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
      .card { width: min(36rem, 100%); overflow: hidden; border: 2px solid var(--dead); border-radius: var(--radius-lg); background: var(--surface); }
      .band { display: flex; align-items: center; gap: 0.7rem; padding: 0.9rem 1.1rem; background: var(--dead); color: #fff; }
      html[data-theme="dark"] .band { background: #3d4a46; color: var(--dead); }
      .band svg { flex: none; }
      .word { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
      .body { padding: 1.15rem 1.15rem 1.25rem; }
      h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.75rem 0 0; }
      .chip { max-width: 100%; overflow-wrap: anywhere; border-radius: 999px; background: var(--soft); padding: 0.2rem 0.55rem; color: var(--ink); font-size: 0.84rem; }
      p.line { margin: 0.9rem 0 0; color: var(--muted); }
      .back {
        display: inline-flex; align-items: center; justify-content: center; min-height: var(--btn-height);
        margin-top: 1rem; padding: 0.5rem 0.85rem; border: 1px solid var(--ink); border-radius: var(--radius);
        background: var(--ink); color: var(--on-ink); font-weight: 600; text-decoration: none;
      }`;

// Preview pages are CSP-sandboxed without allow-same-origin, so localStorage throws.
// Prefer ?mayfly_theme=, then localStorage, then prefers-color-scheme.
const THEME_SCRIPT = `
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
      })();`;

/** A 404 page for an address with no live preview. Repository and number come from the URL, so they are escaped. */
function noPreview(res: Response, repository: string, pr: string, line: string) {
  const shown = (value: string) => escapeHtml(value.length > 100 ? `${value.slice(0, 100)}…` : value);
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>No live preview</title>
    <style>${NOT_FOUND_STYLE}
    </style>
    <script>${THEME_SCRIPT}
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
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
        <p class="word">No preview</p>
      </header>
      <div class="body">
        <h1>No live preview</h1>
        <p class="chips">
          <span class="chip">${shown(repository)}</span>
          <span class="chip">PR #${shown(pr)}</span>
        </p>
        <p class="line">${escapeHtml(line)}</p>
        <a class="back" id="back" href="/board">Back to board</a>
        <script>(function(){var a=document.getElementById("back");try{var fromAdmin=false;var r=document.referrer?new URL(document.referrer):null;if(r&&r.host===location.host&&r.pathname.indexOf("/admin")===0)fromAdmin=true;if(new URLSearchParams(location.search).get("mayfly_from")==="admin")fromAdmin=true;if(fromAdmin){a.href="/admin";a.textContent="Back to admin";}}catch(e){}})();</script>
      </div>
    </main>
  </body>
</html>`;
  res
    .status(404)
    .set({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    .send(body);
}

/**
 * The path inside the preview app, taken from the raw request URL so encodings are preserved.
 * Everything up to and including /p/<owner>/<name>/<pr> is stripped.
 */
function upstreamTarget(originalUrl: string) {
  const q = originalUrl.indexOf("?");
  const pathname = q === -1 ? originalUrl : originalUrl.slice(0, q);
  const search = q === -1 ? "" : originalUrl.slice(q);
  const parts = pathname.split("/"); // ["", "p", owner, name, pr, ...rest]
  const rest = parts.slice(5).join("/");
  return { path: `/${rest}`, search };
}

function countActivity(envId: string) {
  const map = (lastRecorded.__previewActivity ??= new Map());
  const now = Date.now();
  const previous = map.get(envId) ?? 0;
  if (now - previous < ACTIVITY_THROTTLE_MS) return Promise.resolve();
  map.set(envId, now);
  return recordActivity(envId).then(
    () => undefined,
    (error) => console.error("Recording preview activity failed", error),
  );
}

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function copyResponseHeaders(incoming: IncomingMessage): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    headers[key] = value;
  }
  finalizePreviewHeaders(headers);
  return headers;
}

/**
 * Express preview proxy. Streams the client request to the gate/app and the upstream
 * response back — no Web Request/Response conversion.
 */
export async function proxyPreview(req: Request, res: Response): Promise<void> {
  const owner = paramString(req.params.owner);
  const name = paramString(req.params.name);
  const pr = paramString(req.params.pr);
  const notAPreview = "This address is not a pull request preview.";

  if (!/^\d{1,9}$/.test(pr)) {
    noPreview(res, `${owner}/${name}`, pr, notAPreview);
    return;
  }

  let repository: string;
  try {
    repository = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  } catch {
    noPreview(res, `${owner}/${name}`, pr, notAPreview);
    return;
  }

  const target = await findProxyTarget(repository, Number(pr));
  if (!target) {
    noPreview(res, repository, pr, "This pull request was closed, expired or removed, so its preview is gone.");
    return;
  }

  const { path, search } = upstreamTarget(req.originalUrl);
  const method = req.method.toUpperCase();
  // The gate's sleep control is not part of the public preview. Callers who can reach the
  // proxy must not be able to stop the app; Mayfly talks to 127.0.0.1 itself.
  if (path.startsWith("/__preview_") && !(method === "GET" && path === "/__preview_status")) {
    sendText(res, 404, "Not found.");
    return;
  }

  const isStatus = path === "/__preview_status";
  const isProbe = Boolean(req.headers["x-mayfly-probe"]);

  // Only a real visit counts as activity. Status polls and wake probes never do.
  // This is the one place activity is recorded; the forward below goes to the gate, which does not call back.
  const activity = isStatus || isProbe ? Promise.resolve() : countActivity(target.envId);

  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || REQUEST_ONLY_DROP.has(key) || value === undefined) continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${target.port}`;
  const originalHost = req.headers.host;
  if (originalHost) headers["x-forwarded-host"] = originalHost;
  // Same protocol value Express/Mayfly sees for this request (http behind a plain listen).
  headers["x-forwarded-proto"] = req.protocol;

  const hasBody = method !== "GET" && method !== "HEAD";

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let upstream: ReturnType<typeof forward>;
    try {
      upstream = forward(
        { hostname: "127.0.0.1", port: target.port, path: `${path}${search}`, method, headers },
        (incoming) => {
          const responseHeaders = copyResponseHeaders(incoming);
          const status = incoming.statusCode || 502;
          const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;

          res.status(status);
          for (const [key, value] of Object.entries(responseHeaders)) {
            if (value === undefined) continue;
            res.setHeader(key, value);
          }

          if (noBody) {
            incoming.resume();
            res.end();
            finish();
            return;
          }

          incoming.on("error", () => {
            if (!res.headersSent) sendText(res, 502, "Preview is not reachable.");
            else res.destroy();
            finish();
          });
          res.on("close", () => {
            incoming.destroy();
            finish();
          });
          incoming.pipe(res);
          res.on("finish", finish);
        },
      );
    } catch {
      sendText(res, 400, "Invalid preview path.");
      finish();
      return;
    }

    upstream.on("error", () => {
      if (!res.headersSent) sendText(res, 502, "Preview is not reachable.");
      finish();
    });

    const onClientGone = () => {
      upstream.destroy();
      finish();
    };
    req.on("aborted", onClientGone);
    res.on("close", () => {
      if (!res.writableEnded) onClientGone();
    });

    if (hasBody) {
      req.on("error", () => {
        upstream.destroy();
        finish();
      });
      req.pipe(upstream);
    } else {
      upstream.end();
    }
  });

  await activity;
}
