import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { countFeed, getSourceProfile } from "@/core/reader";
import { Listing } from "@/components/Hub";
import { first, pageMeta } from "@/lib/page";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const FAMILY: Record<string, string> = {
  national_authority: "National authority",
  state_local: "State or local body",
  research_professional: "Research or professional body",
  independent_commercial: "Independent or commercial publisher",
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const source = await getSourceProfile(getDb(), slug);
  if (!source) return {};
  const before = first((await searchParams).before);
  const items = await countFeed(getDb(), new Date(), { sourceId: source.id });
  return pageMeta({ title: source.name, description: `Updates and reports that cite ${source.name}, with links to the original publisher.`, path: `/sources/${source.slug}`, indexable: items >= 5 && !before });
}

export default async function SourcePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const db = getDb();
  const source = await getSourceProfile(db, slug);
  if (!source) notFound();
  return (
    <>
      <p className="kicker">Source publisher</p>
      <h1 className="page-title">{source.name}</h1>
      <div className="prose">
        <p>
          {FAMILY[source.family]}
          {source.state && (
            <>
              {" · "}
              <Link href={`/state/${source.state.slug}`}>{source.state.name}</Link>
            </>
          )}
        </p>
        <p>
          <a className="ext" href={source.homepageUrl} rel="noopener external">
            Visit {source.name}
          </a>
        </p>
        <p className="meta">This is an independent publisher. Source updates link to its own pages; our reports that cite it are our own work.</p>
      </div>
      <h2 className="section-title">Updates and reports citing this source</h2>
      <Listing db={db} now={new Date()} basePath={`/sources/${source.slug}`} before={first((await searchParams).before)} filter={{ sourceId: source.id }} empty={<p>Nothing from this source is public at the moment.</p>} />
    </>
  );
}
