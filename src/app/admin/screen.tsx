import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/admin-panel";
import { pageActor } from "@/lib/page-access";

export async function AdminScreen() {
  const actor = await pageActor();
  if (!actor) redirect("/admin/login");
  return <AdminPanel role={actor.role} name={actor.name} />;
}
