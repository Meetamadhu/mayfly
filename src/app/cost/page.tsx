import type { Metadata } from "next";
import { CostPage } from "@/components/cost-page";

export const metadata: Metadata = {
  title: "Cost & savings · Mayfly",
  description: "Estimated spend and savings from sleeping previews.",
};

export default function Cost() {
  return <CostPage />;
}
