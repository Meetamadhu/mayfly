import { json } from "@/lib/http";
import { getOverview } from "@/lib/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await getOverview());
}
