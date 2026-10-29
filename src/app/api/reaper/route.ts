import { requireAdmin } from "@/lib/admin";
import { reap } from "@/lib/lifecycle";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return json(await reap());
}
