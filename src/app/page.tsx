import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { getLead, listFeed, listSections, listTermsWithContent } from "@/core/reader";
import { FeedList } from "@/components/Feed";
import { JsonLd } from "@/components/JsonLd";
import { homeGraph } from "@/core/jsonld";
import { cached, TAG_FEED } from "@/lib/cache";
import { SITE_URL } from "@/lib/site";
import { isoIst, shortDateTime } from "@/lib/format";
import { pageMeta } from "@/lib/page";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMeta({ title: SITE_NAME, description: SITE_TAGLINE, path: "/", indexable: true })), title: { absolute: SITE_NAME } };
}

/** Home: one editorial lead, the latest list, then state and topic discovery (WEB-01, UX-01). */
export default async function Home() {
  const db = getDb();
  const now = new Date();
  const { lead, items, next } = await cached(["home"], [TAG_FEED], async () => ({ lead: await getLead(db, now), ...(await listFeed(db, now, { limit: 12 })) }));
  const latest = items.filter((i) => i.id !== lead?.id).slice(0, 10);
  const sections = await listSections(db);
  const states = await listTermsWithContent(db, "state", now);

  return (
    <>
      <JsonLd graph={homeGraph({ origin: SITE_URL, name: SITE_NAME })} />
      <h1 className="visually-hidden">{SITE_NAME}</h1>
      {!lead && latest.length === 0 ? (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No reports have been published yet</h2>
          <p>Reports and source updates appear here as soon as an editor publishes them.</p>
          <p className="empty-actions">
            <Link className="button primary" href="/submit-news">
              Submit news
            </Link>
            <Link className="button" href="/about">
              About {SITE_NAME}
            </Link>
          </p>
        </section>
      ) : (
        <div className={lead ? "home-top" : undefined}>
          {lead ? (
            <section className="lead" aria-label="Lead story">
              <p className="kicker">{lead.section ? <Link href={`/section/${lead.section.slug}`}>{lead.section.name}</Link> : "News"}</p>
              <h2>
                <Link href={lead.url}>{lead.title}</Link>
              </h2>
              {lead.standfirst && <p className="standfirst">{lead.standfirst}</p>}
              <p className="meta">
                {lead.author && <>{lead.author.name} · </>}
                <time dateTime={isoIst(lead.visibleFrom)}>{shortDateTime(lead.visibleFrom, now)}</time>
              </p>
            </section>
          ) : null}
          <section aria-labelledby="latest-heading">
            <h2 id="latest-heading" className="section-title">
              Latest updates
            </h2>
            {latest.length > 0 ? <FeedList items={latest} now={now} twoCol /> : <p className="note">Nothing new in the last few hours.</p>}
            {(next || latest.length >= 10) && (
              <p style={{ marginTop: "1rem" }}>
                <Link className="button" href="/latest">
                  All latest updates
                </Link>
              </p>
            )}
          </section>
        </div>
      )}

      <div className="discover">
        <section aria-labelledby="states-heading">
          <h2 id="states-heading" className="section-title">
            Browse by state
          </h2>
          <ul className="chips">
            {states.map((s) => (
              <li key={s.slug}>
                <Link href={`/state/${s.slug}`}>{s.name}</Link>
              </li>
            ))}
            <li>
              <Link href="/states">All states and union territories</Link>
            </li>
          </ul>
        </section>
        <section aria-labelledby="sections-heading">
          <h2 id="sections-heading" className="section-title">
            Browse by section
          </h2>
          <ul className="chips">
            {sections.map((s) => (
              <li key={s.slug}>
                <Link href={`/section/${s.slug}`}>{s.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="cta-band" aria-labelledby="cta-heading">
        <div>
          <h2 id="cta-heading">Have health news to share?</h2>
          <p>Send a press release, announcement, research finding or story tip to our desk. An editor reviews every submission before anything is published.</p>
        </div>
        <Link className="button primary" href="/submit-news">
          Submit news
        </Link>
      </section>
    </>
  );
}
