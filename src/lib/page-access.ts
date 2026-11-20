import { cookies } from "next/headers";
import { ADMIN_COOKIE, sessionIsValid } from "./admin";
import { USER_COOKIE, userFromSession } from "./users";

/** For server-rendered pages: the admin, an approved team member, or nobody. */
export async function pageActor(): Promise<{ role: "admin" | "user"; name: string } | null> {
  const jar = await cookies();
  const token = (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
  if (token && sessionIsValid(jar.get(ADMIN_COOKIE)?.value ?? "", token)) return { role: "admin", name: "admin" };
  const user = await userFromSession(jar.get(USER_COOKIE)?.value ?? "");
  return user ? { role: "user", name: user.username } : null;
}
