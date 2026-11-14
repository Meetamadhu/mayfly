import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard";

export const metadata: Metadata = {
  title: "Dashboard · Mayfly",
  description: "Live pull request previews: running, sleeping and building.",
};

export default function BoardPage() {
  return <Dashboard />;
}
