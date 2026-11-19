import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "About", description: "Who publishes India Health News, how it is funded and how it works.", path: "/about", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">About</h1>
      <p className="intro">India Health News follows Indian health developments, shows who reported them and links to the original source.</p>
      <PublisherToSupply items={["Legal publisher name and registered address", "Ownership and funding", "Named editors and the medical reviewer roster", "Advertising policy"]} />
      <h2>What you will find here</h2>
      <ul>
        <li>
          <strong>Our reports.</strong> Written by a named reporter, approved by an editor and linked to at least one original source.
        </li>
        <li>
          <strong>Source updates.</strong> Labelled cards that name another publisher and open that publisher&rsquo;s own page. We do not present their work as ours.
        </li>
      </ul>
      <p>
        Read the <Link href="/editorial-policy">editorial policy</Link>, see our <Link href="/corrections">corrections</Link> or <Link href="/contact">contact the desk</Link>.
      </p>
    </div>
  );
}
