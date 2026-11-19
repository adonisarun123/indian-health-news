import type { Metadata } from "next";
import { PolicyPage, policyMetadata } from "@/components/PolicyPage";

export function generateMetadata(): Promise<Metadata> {
  return policyMetadata("privacy");
}

export default function Page() {
  return <PolicyPage slug="privacy" />;
}
