import { rejectSignIn, sessionCookie, SESSION_MAX_AGE, signIn } from "@/lib/admin";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    token = "";
  }
  const value = signIn(token);
  if (!value) return rejectSignIn();
  const response = json({ ok: true });
  response.headers.set("Set-Cookie", sessionCookie(value, SESSION_MAX_AGE));
  return response;
}

export function DELETE() {
  const response = json({ ok: true });
  response.headers.set("Set-Cookie", sessionCookie("", 0));
  return response;
}
