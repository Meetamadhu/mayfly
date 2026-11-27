import type { Metadata } from "next";
import { OpsPage } from "@/components/ops-page";

export const metadata: Metadata = {
  title: "Health & ops · Mayfly",
  description: "Host health, capacity, and the audit log.",
};

export default function Ops() {
  return <OpsPage />;
}
