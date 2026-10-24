import { reap } from "@/lib/lifecycle";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return json(await reap());
}
