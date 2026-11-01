import type { Metadata } from "next";
import { AdminScreen } from "./screen";

export const metadata: Metadata = {
  title: "Admin · Mayfly",
  description: "Open, sleep, and remove Mayfly previews.",
};

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <AdminScreen />;
}
