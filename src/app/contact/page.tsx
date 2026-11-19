import type { Metadata } from "next";
import Link from "next/link";
import { PublisherToSupply } from "@/components/Draft";
import { pageMeta } from "@/lib/page";

// Not indexable until the publisher's own text replaces the placeholders below.
export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Contact", description: "How to reach the India Health News desk.", path: "/contact", indexable: false });
}

export default function Page() {
  return (
    <div className="prose">
      <h1 className="page-title">Contact</h1>
      <PublisherToSupply items={["Newsroom email address and phone number", "Postal address", "Named contact for rights and licensing questions"]} />
      <p>
        To report an error in a story, see <Link href="/corrections#report">how to report a correction</Link>. For a formal complaint, see <Link href="/complaints">complaints</Link>.
      </p>
    </div>
  );
}
