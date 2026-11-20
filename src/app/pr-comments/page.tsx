import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PrCommentsPage } from "@/components/pr-comments-page";
import { pageActor } from "@/lib/page-access";

export const metadata: Metadata = {
  title: "PR comments · Mayfly",
  description: "The comment and check Mayfly keeps on each pull request.",
};

export const dynamic = "force-dynamic";

/** Comment text is only shown to signed-in people (the public API leaves it out). */
export default async function PrComments() {
  if (!(await pageActor())) redirect("/admin/login?next=/pr-comments");
  return <PrCommentsPage />;
}
