import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PrCommentsPage } from "@/components/pr-comments-page";
import { ADMIN_COOKIE, sessionIsValid } from "@/lib/admin";

export const metadata: Metadata = {
  title: "PR comments · Mayfly",
  description: "The comment and check Mayfly keeps on each pull request.",
};

export const dynamic = "force-dynamic";

/** Comment text is only shown to admins (the public API leaves it out), so the page is admin only. */
export default async function PrComments() {
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value ?? "";
  const token = (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
  if (!token || !sessionIsValid(value, token)) redirect("/admin/login?next=/pr-comments");
  return <PrCommentsPage />;
}
