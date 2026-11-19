import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { Listing } from "@/components/Hub";
import { first, pageMeta } from "@/lib/page";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const before = first((await searchParams).before);
  // Each paginated page is its own canonical address (SEO-01).
  return pageMeta({ title: "Latest updates", description: "Every report and source update, newest first, in Indian Standard Time.", path: before ? `/latest?before=${before}` : "/latest", indexable: !before });
}

export default async function Latest({ searchParams }: Props) {
  const before = first((await searchParams).before);
  return (
    <>
      <h1 className="page-title">Latest updates</h1>
      <p className="intro" style={{ marginBottom: "1.5rem" }}>
        Our own reporting and labelled updates from source publishers, newest first.
      </p>
      <Listing db={getDb()} now={new Date()} basePath="/latest" before={before} empty={<p>Nothing has been published yet.</p>} />
    </>
  );
}
