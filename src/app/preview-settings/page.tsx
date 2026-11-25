import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PreviewSettingsPage } from "@/components/preview-settings-page";
import { ADMIN_COOKIE, sessionIsValid } from "@/lib/admin";

export const metadata: Metadata = {
  title: "Preview settings · Mayfly",
  description: "The size and test values each repository's previews get.",
};

export const dynamic = "force-dynamic";

export default async function PreviewSettings() {
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value ?? "";
  const token = (process.env["MAYFLY_ADMIN_TOKEN"] ?? "").trim();
  if (!token || !sessionIsValid(value, token)) redirect("/admin/login?next=/preview-settings");
  return <PreviewSettingsPage />;
}
