import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PoliciesPage } from "@/components/policies-page";
import { pageActor } from "@/lib/page-access";

export const metadata: Metadata = {
  title: "Lifetime rules · Mayfly",
  description: "How long previews live, when they sleep, and what keeps them around.",
};

export const dynamic = "force-dynamic";

export default async function Policies() {
  const actor = await pageActor();
  if (!actor) redirect("/admin/login?next=/policies");
  // Team members can't change lifetime rules; send them to the page they can use.
  if (actor.role !== "admin") redirect("/admin");
  return <PoliciesPage />;
}
