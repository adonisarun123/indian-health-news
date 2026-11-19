import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Editorial policy", description: "How India Health News sources, reviews, labels and corrects its reporting.", path: "/editorial-policy", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">Editorial policy</h1>
      <PublisherToSupply items={["The publisher's full editorial standards", "The medical review policy and reviewer credentials policy", "The policy on sponsorship and press material"]} />
      <h2>Rules the publishing system enforces</h2>
      <ul>
        <li>Every item names its originating publisher and links directly to the specific notice, article or document.</li>
        <li>A report of ours is published only after a named editor approves the exact version that goes out. Any edit needs fresh approval.</li>
        <li>Clinical and high-impact reports also need sign-off from a credentialed medical reviewer, who must be a different person from the editor.</li>
        <li>Items about drug safety, outbreaks, vaccines, treatment or research results are never posted automatically.</li>
        <li>Analysis, press material and republished partner content are labelled as such.</li>
        <li>A correction keeps the address and the original publication time, and adds a dated note saying what changed.</li>
      </ul>
      <p>
        See the record of <Link href="/corrections">corrections</Link>.
      </p>
    </div>
  );
}
