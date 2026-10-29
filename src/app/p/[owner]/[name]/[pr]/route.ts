import { proxyPreview } from "@/lib/preview-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ owner: string; name: string; pr: string }> };

async function handle(request: Request, context: RouteContext) {
  return proxyPreview(request, await context.params);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
