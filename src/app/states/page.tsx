import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { terms } from "@/db/schema";
import { listTermsWithContent } from "@/core/reader";
import { pageMeta } from "@/lib/page";

export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "States and union territories", description: "Browse health coverage by state or union territory.", path: "/states", indexable: true });
}

export default async function States() {
  const db = getDb();
  const all = await db.select({ slug: terms.slug, name: terms.name }).from(terms).where(eq(terms.kind, "state")).orderBy(asc(terms.name));
  const covered = new Map((await listTermsWithContent(db, "state", new Date())).map((s) => [s.slug, s.count]));
  const withContent = all.filter((s) => covered.has(s.slug));
  const without = all.filter((s) => !covered.has(s.slug));
  return (
    <>
      <h1 className="page-title">States and union territories</h1>
      <p className="intro">India-wide reports appear in the latest updates. You do not need to share your location.</p>
      <h2 className="section-title">With current coverage</h2>
      {withContent.length > 0 ? (
        <ul className="chips">
          {withContent.map((s) => (
            <li key={s.slug}>
              <Link href={`/state/${s.slug}`}>
                {s.name} ({covered.get(s.slug)})
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">No state coverage yet.</p>
      )}
      <h2 className="section-title">Not yet covered</h2>
      <p className="meta" style={{ maxWidth: "var(--measure)" }}>
        {without.map((s) => s.name).join(" · ")}
      </p>
      <p style={{ marginTop: "1rem" }}>
        <Link href="/latest">See the latest from across India</Link>
      </p>
    </>
  );
}
