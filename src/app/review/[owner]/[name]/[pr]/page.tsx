import type { Metadata } from "next";
import { ReviewPage } from "@/components/review-page";

export const metadata: Metadata = {
  title: "Review · Mayfly",
  description: "Mark a spot on a preview and leave a comment.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ owner: string; name: string; pr: string }> };

/** Open to anyone; the comments API decides who may see and post (admins, or the preview's feedback link). */
export default async function Review({ params }: RouteContext) {
  const { owner, name, pr } = await params;
  return <ReviewPage owner={decodeURIComponent(owner)} name={decodeURIComponent(name)} pr={pr} />;
}
