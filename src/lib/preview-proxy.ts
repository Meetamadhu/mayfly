import { request as forward } from "node:http";
import { Readable } from "node:stream";
import { findProxyTarget, recordActivity } from "./lifecycle";

export interface PreviewParams {
  owner: string;
  name: string;
  pr: string;
  path?: string[];
}

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

// A page load fans out into many asset requests. One state write per environment per second is plenty.
const ACTIVITY_THROTTLE_MS = 1000;
const lastRecorded = globalThis as unknown as { __previewActivity?: Map<string, number> };

function text(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// What a person sees at a preview address that has no live preview. The look follows the demo preview page
// (scripts/preview-server.mjs): same colours, card and light/dark theme script.
const NOT_FOUND_STYLE = `
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #efece4; color: #1c1915; font-family: "Segoe UI", system-ui, sans-serif; }
      .card { width: min(36rem, calc(100% - 2rem)); overflow: hidden; border: 1px solid #ddd6c8; border-radius: 14px; background: #f7f5ef; }
      .band { display: flex; align-items: center; gap: 0.7rem; padding: 0.9rem 1.1rem; background: #5b554b; color: #fff; }
      .band svg { flex: none; }
      .word { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; }
      .body { padding: 1.15rem 1.15rem 1.25rem; }
      h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.75rem 0 0; }
      .chip { max-width: 100%; overflow-wrap: anywhere; border-radius: 999px; background: #e7e1d4; padding: 0.2rem 0.55rem; color: #1c1915; font-size: 0.84rem; }
      p.line { margin: 0.9rem 0 0; color: #6f685e; }
      .back { display: inline-flex; align-items: center; min-height: 44px; margin-top: 1rem; padding: 0 0.9rem; border-radius: 6px; background: #1c1915; color: #f7f5ef; font-weight: 600; text-decoration: none; }
      html[data-theme="dark"] body { background: #141311; color: #f6f3ec; }
      html[data-theme="dark"] .card { background: #221f1a; border-color: #3d362e; }
      html[data-theme="dark"] .band { background: #3d362e; }
      html[data-theme="dark"] .chip { background: #2c2822; color: #f6f3ec; }
      html[data-theme="dark"] p.line { color: #c9c0b4; }
      html[data-theme="dark"] a.back { background: #f6f3ec; color: #141311; }`;

const THEME_SCRIPT = `
      try {
        var theme = localStorage.getItem("mayfly-theme");
        if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        document.documentElement.dataset.theme = theme;
      } catch (e) {}`;

/** A 404 page for an address with no live preview. Repository and number come from the URL, so they are escaped. */
function noPreview(repository: string, pr: string, line: string) {
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
    <main class="card">
      <header class="band">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
        <p class="word">NO PREVIEW</p>
      </header>
      <div class="body">
        <h1>No live preview</h1>
        <p class="chips">
          <span class="chip">${shown(repository)}</span>
          <span class="chip">PR #${shown(pr)}</span>
        </p>
        <p class="line">${escapeHtml(line)}</p>
        <a class="back" href="/board">Back to board</a>
      </div>
    </main>
  </body>
</html>`;
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/**
 * The path inside the preview app, taken from the raw request URL so encodings are preserved.
 * Everything up to and including /p/<owner>/<name>/<pr> is stripped.
 */
function upstreamTarget(requestUrl: string) {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/"); // ["", "p", owner, name, pr, ...rest]
  const rest = parts.slice(5).join("/");
  return { path: `/${rest}`, search: url.search };
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

export async function proxyPreview(request: Request, params: PreviewParams): Promise<Response> {
  const notAPreview = "This address is not a pull request preview.";
  if (!/^\d{1,9}$/.test(params.pr)) return noPreview(`${params.owner}/${params.name}`, params.pr, notAPreview);
  let repository: string;
  try {
    repository = `${decodeURIComponent(params.owner)}/${decodeURIComponent(params.name)}`;
  } catch {
    return noPreview(`${params.owner}/${params.name}`, params.pr, notAPreview);
  }

  const target = await findProxyTarget(repository, Number(params.pr));
  if (!target) {
    return noPreview(repository, params.pr, "This pull request was closed, expired or removed, so its preview is gone.");
  }

  const { path, search } = upstreamTarget(request.url);
  const method = request.method.toUpperCase();
  // The gate's sleep control is not part of the public preview. Callers who can reach the
  // proxy must not be able to stop the app; Mayfly talks to 127.0.0.1 itself.
  if (path.startsWith("/__preview_") && !(method === "GET" && path === "/__preview_status")) {
    return text(404, "Not found.");
  }
  const isStatus = path === "/__preview_status";
  const isProbe = request.headers.has("x-mayfly-probe");

  // Only a real visit counts as activity. Status polls and wake probes never do.
  // This is the one place activity is recorded; the forward below goes to the gate, which does not call back.
  const activity = isStatus || isProbe ? Promise.resolve() : countActivity(target.envId);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key) || REQUEST_ONLY_DROP.has(key)) return;
    headers[key] = value;
  });
  headers.host = `127.0.0.1:${target.port}`;
  const originalHost = request.headers.get("host");
  if (originalHost) headers["x-forwarded-host"] = originalHost;
  headers["x-forwarded-proto"] = new URL(request.url).protocol.replace(":", "");

  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;

  const upstreamResponse = await new Promise<Response>((resolve) => {
    let upstream: ReturnType<typeof forward>;
    try {
      upstream = forward(
        { hostname: "127.0.0.1", port: target.port, path: `${path}${search}`, method, headers },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (HOP_BY_HOP.has(key) || value === undefined) continue;
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
            else responseHeaders.set(key, value);
          }
          const status = incoming.statusCode || 502;
          const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
          if (noBody) incoming.resume();
          // Resolve as soon as headers arrive and stream the rest: a waking page returns immediately.
          resolve(
            new Response(noBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream), {
              status,
              headers: responseHeaders,
            }),
          );
        },
      );
    } catch {
      resolve(text(400, "Invalid preview path."));
      return;
    }

    upstream.on("error", () => resolve(text(502, "Preview is not reachable.")));
    request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });

    if (hasBody) {
      const body = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream);
      body.on("error", () => upstream.destroy());
      body.pipe(upstream);
    } else {
      upstream.end();
    }
  });

  await activity;
  return upstreamResponse;
}
