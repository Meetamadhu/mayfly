import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PoliciesPage } from "@/components/policies-page";
import { ADMIN_COOKIE, sessionIsValid } from "@/lib/admin";

export const metadata: Metadata = {
  title: "Lifetime rules · Mayfly",
  description: "How long previews live, when they sleep, and what keeps them around.",
};

export const dynamic = "force-dynamic";

export default async function Policies() {
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value ?? "";
  const token = (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
  if (!token || !sessionIsValid(value, token)) redirect("/admin/login?next=/policies");
  return <PoliciesPage />;
}
