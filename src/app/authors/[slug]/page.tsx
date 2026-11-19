import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { countFeed, getAuthor } from "@/core/reader";
import { Listing } from "@/components/Hub";
import { JsonLd } from "@/components/JsonLd";
import { profileGraph } from "@/core/jsonld";
import { first, pageMeta } from "@/lib/page";
import { SITE_NAME, SITE_URL } from "@/lib/site";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const ROLE: Record<string, string> = { reporter: "Reporter", editor: "Editor", managing_editor: "Managing editor", medical_reviewer: "Medical reviewer" };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const author = await getAuthor(getDb(), slug);
  if (!author) return {};
  const before = first((await searchParams).before);
  // A profile is indexable once it carries published work.
  const substantive = (await countFeed(getDb(), new Date(), { authorId: author.id })) > 0;
  return pageMeta({ title: author.name, description: author.bio ?? `Reports by ${author.name}.`, path: `/authors/${author.slug}`, indexable: substantive && !before });
}

export default async function AuthorPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const db = getDb();
  const author = await getAuthor(db, slug);
  if (!author) notFound();
  const roles = author.roles.map((r) => ROLE[r]).filter(Boolean);
  return (
    <>
      <JsonLd graph={profileGraph({ origin: SITE_URL, name: SITE_NAME }, { name: author.name, slug: author.slug, bio: author.bio, jobTitle: roles[0] ?? null, credentials: author.credentials })} />
      <p className="kicker">{roles.join(" · ") || "Staff"}</p>
      <h1 className="page-title">{author.name}</h1>
      <div className="prose">
        {author.bio ? <p className="intro">{author.bio}</p> : <p className="meta">A biography has not been published yet.</p>}
        {author.credentials && (
          <p>
            <strong>Credentials:</strong> {author.credentials}
          </p>
        )}
        <p>
          <strong>Declared interests:</strong> {author.conflicts ?? "None declared."}
        </p>
        {author.reviews > 0 && <p>Has medically reviewed {author.reviews} published {author.reviews === 1 ? "report" : "reports"}.</p>}
      </div>
      <h2 className="section-title">Recent work</h2>
      <Listing db={db} now={new Date()} basePath={`/authors/${author.slug}`} before={first((await searchParams).before)} filter={{ authorId: author.id }} empty={<p>No published reports yet.</p>} />
    </>
  );
}
