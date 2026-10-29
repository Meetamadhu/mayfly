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
  if (!/^\d{1,9}$/.test(params.pr)) return text(404, "No preview for this pull request.");
  let repository: string;
  try {
    repository = `${decodeURIComponent(params.owner)}/${decodeURIComponent(params.name)}`;
  } catch {
    return text(404, "No preview for this pull request.");
  }

  const target = await findProxyTarget(repository, Number(params.pr));
  if (!target) return text(404, "No live preview for this pull request.");

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
