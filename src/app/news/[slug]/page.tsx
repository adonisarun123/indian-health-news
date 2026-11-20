import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import type { Block } from "@/core/articles";
import { getPublicArticle } from "@/core/public";
import { linkStatuses } from "@/core/cases";
import { getArticleContext, listFeed } from "@/core/reader";
import { ArticleBody as Body } from "@/components/ArticleBody";
import { Teaser } from "@/components/Feed";
import { WithRail } from "@/components/Rail";
import { Share } from "@/components/Share";
import { isoIst, longDate, longDateTime } from "@/lib/format";
import { pageMeta } from "@/lib/page";
import { JsonLd } from "@/components/JsonLd";
import { articleGraph } from "@/core/jsonld";
import { absolute, SITE_NAME, SITE_URL } from "@/lib/site";

type Props = { params: Promise<{ slug: string }> };

// One lookup per request, shared by metadata and the page.
// Always read live: a story page is never served from the data cache (ARC-02).
const load = cache(async (slug: string) => getPublicArticle(getDb(), slug, new Date()));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === "retracted") return pageMeta({ title: "Retracted report", description: "This report has been retracted.", path: `/news/${r.slug}`, indexable: false });
  if (r.kind !== "ok") return {};
  const a = r.article;
  return pageMeta({
    title: a.headline,
    description: a.standfirst || `${a.headline}. Read the report and open the original source.`,
    path: `/news/${a.slug}`,
    indexable: a.robots === "index",
    type: "article",
    publishedTime: isoIst(a.publishedAt),
    modifiedTime: a.modifiedAt ? isoIst(a.modifiedAt) : undefined,
    canonical: a.canonicalUrl,
  });
}

const TYPE_LABEL: Record<string, string> = { analysis: "Analysis", press_material: "Press material" };

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const r = await load(slug);
  // A moved story answers with a single permanent redirect (SEO-01).
  if (r.kind === "redirect") permanentRedirect(`/news/${r.slug}`);
  if (r.kind === "retracted") {
    return (
      <article className="article">
        <h1>This report has been retracted</h1>
        <div className="retraction">
          <p>
            <strong>Retracted on {longDate(r.date)}.</strong> {r.note ?? "The report has been withdrawn."}
          </p>
        </div>
        <p>
          See our <Link href="/corrections">corrections</Link> or return to the <Link href="/latest">latest updates</Link>.
        </p>
      </article>
    );
  }
  // Removed stories are answered with 410 or 451 before rendering (see proxy.ts).
  if (r.kind !== "ok") notFound();

  const a = r.article;
  const db = getDb();
  const now = new Date();
  const ctx = await getArticleContext(db, a.id, a.publicVersionId);
  const primary = a.citations.find((c) => c.isPrimary) ?? a.citations[0];
  const partner = a.type === "licensed_copy";
  // Verbatim official release: credited to its publisher, like a partner copy.
  const reproduced = partner || Boolean(a.canonicalUrl);
  const links = await linkStatuses(db, a.citations.map((c) => c.url));
  const related = ctx.section
    ? (await listFeed(db, now, { termId: ctx.section.id, kind: "article", excludeArticleId: a.id, limit: 4 })).items
    : [];

  const graph = articleGraph(
    { origin: SITE_URL, name: SITE_NAME },
    {
      slug: a.slug,
      type: a.type,
      reproduced,
      headline: a.headline,
      section: ctx.section ? { name: ctx.section.name, slug: ctx.section.slug } : null,
      author: a.author,
      publishedAt: a.publishedAt,
      modifiedAt: a.modifiedAt,
      citations: a.citations.map((c) => c.url),
      reviewer: ctx.medicalReview ? { name: ctx.medicalReview.name, slug: ctx.medicalReview.slug, hasProfile: ctx.medicalReview.isPublic } : null,
    },
  );

  return (
    <WithRail now={now} excludeUrls={[`/news/${a.slug}`]}>
    <article className="article">
      <JsonLd graph={graph} />
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Home</Link>
          </li>
          {ctx.section && (
            <li>
              <Link href={`/section/${ctx.section.slug}`}>{ctx.section.name}</Link>
            </li>
          )}
        </ol>
      </nav>

      {reproduced && <p className="label-strip">Republished from {primary?.publisher}</p>}
      {TYPE_LABEL[a.type] && !reproduced && <p className="label-strip">{TYPE_LABEL[a.type]}</p>}
      <p className="kicker">
        {ctx.section && <Link href={`/section/${ctx.section.slug}`}>{ctx.section.name}</Link>}
        {ctx.states.map((s) => (
          <span key={s.slug}>
            {" · "}
            <Link href={`/state/${s.slug}`}>{s.name}</Link>
          </span>
        ))}
      </p>
      <h1>{a.headline}</h1>
      {a.standfirst && <p className="standfirst">{a.standfirst}</p>}

      <div className="article-meta">
      <p className="byline">
        {reproduced ? (
          <>By {a.sourceAuthorLabel && a.sourceAuthorLabel !== primary?.publisher ? `${a.sourceAuthorLabel}, ${primary?.publisher}` : primary?.publisher}</>
        ) : a.author ? (
          <>By {a.author.hasProfile ? <Link href={`/authors/${a.author.slug}`}>{a.author.name}</Link> : a.author.name}</>
        ) : (
          "By the Health Desk"
        )}
      </p>
      <p className="meta">
        {a.sourceIssuedAt ? (
          <>
            {a.sourceIssuer ? `Issued by the ${a.sourceIssuer}` : "Issued"} on <time dateTime={isoIst(a.sourceIssuedAt)}>{longDateTime(a.sourceIssuedAt)}</time>
            <br />
            Republished here <time dateTime={isoIst(a.publishedAt)}>{longDateTime(a.publishedAt)}</time>
          </>
        ) : (
          <>
            Published <time dateTime={isoIst(a.publishedAt)}>{longDateTime(a.publishedAt)}</time>
          </>
        )}
        {a.modifiedAt && (
          <>
            <br />
            Updated <time dateTime={isoIst(a.modifiedAt)}>{longDateTime(a.modifiedAt)}</time>
          </>
        )}
      </p>
      {ctx.medicalReview && (
        <p className="meta">
          Medically reviewed by {ctx.medicalReview.isPublic ? <Link href={`/authors/${ctx.medicalReview.slug}`}>{ctx.medicalReview.name}</Link> : ctx.medicalReview.name}
          {ctx.medicalReview.specialty && <>, {ctx.medicalReview.specialty}</>}
        </p>
      )}
      </div>

      {primary && (
        <aside className="primary-source" aria-label="Primary source">
          <p className="kicker">Primary source · {primary.publisher}</p>
          <a className="open ext" href={primary.url} rel="noopener external">
            Open original source
            <span className="visually-hidden">
              : {primary.label} at {primary.publisher}
            </span>
          </a>
        </aside>
      )}

      <Body blocks={a.body as Block[]} />

      {a.correctionNote && a.modifiedAt && (
        <aside className="correction" aria-label="Correction">
          <strong>Correction, {longDate(a.modifiedAt)}:</strong> {a.correctionNote}
        </aside>
      )}

      <section className="sources" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="section-title">
          Sources
        </h2>
        <ol>
          {a.citations.map((c) => (
            <li key={c.url}>
              <a className="ext" href={c.url} rel="noopener external">
                {c.label}
              </a>
              <span>
                {c.publisher}
                {c.isPrimary && " · primary source"}
              </span>
              {links.get(c.url)?.status === "replaced" && links.get(c.url)!.replacementUrl ? (
                <span>
                  This link has moved.{" "}
                  <a className="ext" href={links.get(c.url)!.replacementUrl!} rel="noopener external">
                    Open the verified replacement
                  </a>
                </span>
              ) : links.has(c.url) ? (
                <span>{links.get(c.url)!.status === "broken" ? "This link no longer works. The original citation is kept on record." : "A reader reported this link as broken. We are checking it."}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <Share url={absolute(`/news/${a.slug}`)} title={a.headline} />

      <p className="meta" style={{ marginTop: "1.5rem" }}>
        Spotted an error? <Link href={`/corrections?story=${a.slug}#report`}>Report a correction</Link> or <Link href="/contact">contact the desk</Link>.
      </p>

      {related.length > 0 && (
        <section className="related" aria-labelledby="related-heading">
          <h2 id="related-heading" className="block-title">
            {ctx.section ? <>More in {ctx.section.name}</> : "Related reports"}
          </h2>
          <ul className="related-grid">
            {related.map((i) => (
              <li key={i.id}>
                <Teaser item={i} now={now} size="s" kicker={false} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
    </WithRail>
  );
}
