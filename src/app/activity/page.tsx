import type { Metadata } from "next";
import { ActivityPage } from "@/components/activity-page";

export const metadata: Metadata = {
  title: "Activity · Mayfly",
  description: "Every build, sleep, wake and removal across Mayfly previews.",
};

export default function Activity() {
  return <ActivityPage />;
}
