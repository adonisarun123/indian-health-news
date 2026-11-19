import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Privacy", description: "What India Health News collects and how to make a privacy request.", path: "/privacy", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">Privacy</h1>
      <PublisherToSupply items={["The reviewed privacy notice", "Processors and retention periods", "How to make a privacy request, and the contact for it"]} />
      <h2>How the site works today</h2>
      <ul>
        <li>You can read everything without an account.</li>
        <li>The site does not ask for your location. State pages are chosen by you.</li>
        <li>Source links take you to other publishers&rsquo; sites, which have their own privacy practices.</li>
      </ul>
    </div>
  );
}
