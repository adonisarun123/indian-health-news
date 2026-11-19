import type { Metadata } from "next";
import { PolicyPage, policyMetadata } from "@/components/PolicyPage";

export function generateMetadata(): Promise<Metadata> {
  return policyMetadata("contact");
}

export default function Page() {
  return <PolicyPage slug="contact" />;
}
