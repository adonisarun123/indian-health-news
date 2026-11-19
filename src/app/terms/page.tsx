import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Terms", description: "Terms of use for India Health News.", path: "/terms", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">Terms</h1>
      <PublisherToSupply items={["The reviewed terms of use", "Governing law and the legal entity that offers the site"]} />
      <p>Reports on this site are news, not medical advice. For a personal health decision, speak to a qualified clinician.</p>
    </div>
  );
}
