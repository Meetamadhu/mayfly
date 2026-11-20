import type { Metadata } from "next";
import { SignUpForm } from "@/components/signup-form";

export const metadata: Metadata = {
  title: "Create an account · Mayfly",
  description: "Sign up to manage Mayfly previews. The admin approves new accounts.",
};

export default function SignUpPage() {
  return <SignUpForm />;
}
