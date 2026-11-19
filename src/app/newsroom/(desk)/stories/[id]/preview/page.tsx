import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { CommandError, getDraft } from "@/core/articles";
import { ArticleBody } from "@/components/ArticleBody";
import { requireStaff } from "@/lib/session";
import { absolute, SITE_NAME } from "@/lib/site";

export const metadata = { title: "Preview" };

/** Authenticated, uncached, noindex preview of the private draft (SEC-02, ED-02). */
export default async function Preview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaff();
  let d;
  try {
    d = await getDraft(getDb(), staff, id);
  } catch (e) {
    if (e instanceof CommandError) notFound();
    throw e;
  }
  const c = d.content;
  const primary = c.citations.find((x) => x.isPrimary) ?? c.citations[0];
  return (
    <>
      <p className="flash error" role="note">
        Private preview of draft v{d.draftVersion}. Not public. <Link href={`/newsroom/stories/${id}`}>Back to the story</Link>
      </p>
      <h2>Phone layout</h2>
      <div style={{ maxWidth: "390px", border: "1px solid var(--rule)", borderRadius: "16px", padding: "1rem" }}>
        <article className="article">
          <h1>{c.headline}</h1>
          {c.standfirst && <p className="standfirst">{c.standfirst}</p>}
          {primary && (
            <aside className="primary-source">
              <p className="kicker">Primary source · {primary.publisherName}</p>
              <a className="open ext" href={primary.url} rel="noopener external">
                Open original source
              </a>
            </aside>
          )}
          <ArticleBody blocks={c.body} />
        </article>
      </div>
      <h2>Search result</h2>
      <div className="panel">
        <p style={{ color: "var(--brand)", fontSize: "1.125rem" }}>
          {c.headline} | {SITE_NAME}
        </p>
        <p className="meta">{absolute(`/news/${d.article.slug}`)}</p>
        <p>{c.standfirst || "No standfirst: the search description will be generic."}</p>
      </div>
      <h2>Share card (WhatsApp and social)</h2>
      <div className="panel" style={{ maxWidth: "24rem" }}>
        <strong>{c.headline}</strong>
        <p>{c.standfirst}</p>
        <p className="meta">Text-led card: no cleared image is attached.</p>
      </div>
    </>
  );
}
