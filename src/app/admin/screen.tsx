import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/admin-panel";
import { ADMIN_COOKIE, sessionIsValid } from "@/lib/admin";

export async function AdminScreen() {
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value ?? "";
  const token = (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
  if (!token || !sessionIsValid(value, token)) redirect("/admin/login");
  return <AdminPanel />;
}
