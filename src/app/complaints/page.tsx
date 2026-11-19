import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Complaints", description: "How to make a complaint about India Health News and how it is handled.", path: "/complaints", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">Complaints</h1>
      <PublisherToSupply items={["Grievance officer name and contact", "Acknowledgement and resolution timelines", "The escalation route that applies to this publisher"]} />
      <p>
        For a factual error, a broken source link, a rights objection or a privacy concern, start with <Link href="/corrections#report">reporting a correction</Link>.
      </p>
    </div>
  );
}
