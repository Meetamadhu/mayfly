import type { Metadata } from "next";
import { PricingPage } from "@/components/pricing-page";

export const metadata: Metadata = {
  title: "Pricing · Mayfly",
  description: "Mayfly's plans: how many previews run at once, for how many repositories, and in which sizes.",
};

export default function Pricing() {
  return <PricingPage />;
}
